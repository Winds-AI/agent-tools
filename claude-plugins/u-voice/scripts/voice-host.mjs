import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectronRuntime } from './electron-runtime.mjs';
import { audioEnvironment, detectAudioTarget, hostPath, prepareAudioFiles } from './audio-platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export async function launchAudioHost(url, {
  syntheticWav = process.env.UVOICE_TEST_AUDIO_WAV,
  cacheRoot,
  signal,
  onEvent = () => {},
} = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-zA-Z0-9_%.-]+$/.test(url)) throw new Error('Invalid local audio address.');
  let child, files, stopped = false;
  const target = await detectAudioTarget({ signal });
  const runtime = await ensureElectronRuntime({
    platform: target.platform,
    arch: target.arch,
    cacheRoot: cacheRoot ?? target.cacheRoot,
    signal,
    onProgress: event => onEvent({ type: 'host.progress', ...event }),
  });
  files = await prepareAudioFiles(runtime.runtimeDir, target, { syntheticWav, signal });
  const application = await hostPath(files.application, target, { signal });
  const config = {
    url,
    profilePath: await hostPath(files.profilePath, target, { signal }),
    ...(files.wav ? { syntheticWav: await hostPath(files.wav, target, { signal }), suppressTestPlayback: true } : {}),
  };
  child = spawn(runtime.executablePath, [application], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: audioEnvironment() });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify(config) + '\n');
  const closed = new Promise(resolve => child.once('close', resolve));
  const stop = async () => {
    if (stopped) return; stopped = true;
    try { child?.stdin.end('stop\n'); } catch {}
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { child?.kill('SIGTERM'); resolve(); }, 3000); })]);
    clearTimeout(timer);
    if (files?.profilePath) await rm(files.profilePath, { recursive: true, force: true });
  };
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Background audio startup timed out.'));
    }, 120000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    };
    child.once('error', () => finish(new Error('Could not start the Electron audio host.')));
    child.once('close', () => finish(new Error('Background audio host exited.')));
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 128_000) { finish(new Error('Invalid audio host response.')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let item; try { item = JSON.parse(line); } catch { continue; }
        if (item?.type) onEvent(item);
        if (item.type === 'host.ready') finish();
        else if (item.type === 'host.error') finish(new Error(item.message || 'Could not run background audio.'));
      }
    });
  });
  try { await ready; } catch (error) { await stop(); throw error; }
  return { stop, closed, hidden: true };
}

async function main() {
  let helper, audio, closing = false, startup, base, connectionDeadline, audioAbort;
  const token = process.env.UVOICE_BRIDGE_TOKEN;
  if (!token || token.length < 24) { process.exitCode = 1; return; }
  const output = event => process.stdout.write(JSON.stringify(event) + '\n');
  const stop = async () => {
    if (closing) return; closing = true;
    audioAbort?.abort();
    clearTimeout(connectionDeadline);
    if (base) {
      try { await fetch(base + '/shutdown', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(500) }); } catch {}
    }
    await audio?.stop();
    helper?.stdin.end();
    helper?.kill('SIGTERM');
  };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  helper = spawn(process.execPath, [join(here, '../helper/server.mjs')], { env: { ...process.env, UVOICE_PARENT_PIPE: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
  helper.stdin.on('error', () => {});
  helper.once('error', () => { output({ type: 'error', message: 'Could not start the voice helper.' }); void stop(); process.exitCode = 1; });
  let buffer = '';
  helper.stdout.on('data', data => {
    buffer += data;
    if (buffer.length > 256000) { void stop(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      output(event);
      if (event.type === 'status' && ['listening', 'muted', 'error'].includes(event.phase)) clearTimeout(connectionDeadline);
      if (event.type === 'ready' && !startup) {
        base = 'http://127.0.0.1:' + event.port;
        connectionDeadline = setTimeout(() => {
          if (closing) return;
          output({ type: 'error', message: 'Voice connection timed out. Check microphone permission and local network access, then retry /v.' });
          process.exitCode = 1;
          void stop();
        }, 60000);
        startup = (async () => {
          const control = await fetch(base + '/control', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'connect' }), signal: AbortSignal.timeout(3000) });
          if (!control.ok) throw new Error('Could not start voice.');
          if (closing) return;
          audioAbort = new AbortController();
          const acquired = await launchAudioHost(base + '/#token=' + encodeURIComponent(token), { signal: audioAbort.signal, onEvent: output });
          if (closing) { await acquired.stop(); return; }
          audio = acquired;
          void audio.closed.then(() => { if (!closing) { output({ type: 'error', message: 'Background audio stopped. Use /v to reconnect.' }); void stop(); } });
        })().catch(error => { if (!closing) { output({ type: 'error', message: error.message }); process.exitCode = 1; void stop(); } });
      }
    }
  });
  helper.once('close', () => { void stop(); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
