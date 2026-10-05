import { spawn, execFile } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

async function windowsPath(path) {
  if (process.platform === 'win32') return path;
  return (await runFile('wslpath', ['-w', path], { timeout: 3000 })).stdout.trim();
}

export async function launchAudioHost(url, { browser = process.env.UVOICE_BROWSER, syntheticWav = process.env.UVOICE_TEST_AUDIO_WAV } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-zA-Z0-9_%.-]+$/.test(url)) throw new Error('Invalid local audio address.');
  let child, profile;
  const wsl = !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
  try {
    if (wsl || process.platform === 'win32') {
      const script = await windowsPath(join(here, 'audio-host.ps1'));
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({ url, browser: browser ? (browser.startsWith('/') ? await windowsPath(browser) : browser) : undefined, syntheticWav: syntheticWav ? await windowsPath(resolve(syntheticWav)) : undefined }) + '\n');
    } else {
      if (process.platform !== 'linux') throw new Error('Background voice currently supports Windows, WSL and Linux.');
      if (!browser) {
        for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']) {
          try { await access(candidate); browser = candidate; break; } catch {}
        }
      }
      if (!browser) throw new Error('Set UVOICE_BROWSER to your Chrome or Chromium executable.');
      profile = await mkdtemp(join(tmpdir(), 'uvoice-'));
      const flags = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--user-data-dir=' + profile];
      if (syntheticWav) flags.push('--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + resolve(syntheticWav) + '%noloop');
      flags.push(url);
      child = spawn('bash', [join(here, 'audio-host.sh'), browser, profile, ...flags], { stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdin.on('error', () => {});
    }
    let stopped = false;
    const closed = new Promise(resolve => child.once('close', resolve));
    const ready = new Promise((resolve, reject) => {
      let buffer = '';
      const timeout = setTimeout(() => reject(new Error('Background audio startup timed out.')), 15000);
      const finish = (error) => { clearTimeout(timeout); error ? reject(error) : resolve(); };
      child.once('error', () => finish(new Error('Could not start the background audio host.')));
      child.once('close', () => finish(new Error('Background audio host exited.')));
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 64_000) { finish(new Error('Invalid audio host response.')); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try { const item = JSON.parse(line); if (item.type === 'host.ready') finish(); else if (item.type === 'host.error') finish(new Error('Could not run background audio. Chrome or Edge and microphone access are required.')); } catch {}
        }
      });
    });
    const stop = async () => {
      if (stopped) return; stopped = true;
      child.stdin.end('stop\n');
      let timer;
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 2000); })]);
      clearTimeout(timer);
      if (profile) await rm(profile, { recursive: true, force: true });
    };
    try { await ready; } catch (error) { await stop(); throw error; }
    return { stop, closed, hidden: true };
  } catch (error) {
    if (child) { child.stdin.end(); child.kill('SIGTERM'); }
    if (profile) await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  let helper, audio, closing = false, startup, base, connectionDeadline;
  const token = process.env.UVOICE_BRIDGE_TOKEN;
  if (!token || token.length < 24) { process.exitCode = 1; return; }
  const output = event => process.stdout.write(JSON.stringify(event) + '\n');
  const stop = async () => {
    if (closing) return; closing = true;
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
          output({ type: 'error', message: 'Voice connection timed out. Check Windows microphone access and WSL localhost forwarding, then retry /v.' });
          process.exitCode = 1;
          void stop();
        }, 60000);
        startup = (async () => {
          const control = await fetch(base + '/control', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'connect' }), signal: AbortSignal.timeout(3000) });
          if (!control.ok) throw new Error('Could not start voice.');
          if (closing) return;
          const acquired = await launchAudioHost(base + '/#token=' + encodeURIComponent(token));
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
