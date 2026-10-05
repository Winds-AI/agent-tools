#!/usr/bin/env node
// Live, subscription-backed smoke test. Supply synthetic audio; never uses a real microphone.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = process.env.UVOICE_SMOKE_PLUGIN_DIR || root;
const scratch = join(root, '.scratch/voice-audio-smoke');
const wav = process.env.UVOICE_SMOKE_WAV;
const chrome = process.env.UVOICE_SMOKE_CHROME;
const browserSession = 'uvoice-audio-smoke';
if (!wav || !chrome) throw new Error('Set UVOICE_SMOKE_WAV and UVOICE_SMOKE_CHROME to synthetic audio and a Chromium executable.');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const token = randomBytes(32).toString('hex');
const evidence = { startedAt: new Date().toISOString(), checks: {}, claude: {}, outcome: 'failed' };
let child, base, state, exitCode, stderrBytes = 0, childClosed, browserStarted = false;
let stage = 'prepare';
let resultCount = 0;
const deadline = Date.now() + 120_000;
async function local(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('local_http_' + response.status);
  return response.json();
}
async function browser(...args) {
  return runFile('agent-browser', ['--session', browserSession, ...args], { timeout: 35_000, maxBuffer: 1024 * 1024 });
}
async function waitFor(predicate, ms = 45_000) {
  const until = Math.min(deadline, Date.now() + ms);
  while (Date.now() < until) {
    if (exitCode !== undefined) throw new Error('claude_exited');
    try { state = await local('/state'); } catch {}
    if (predicate(state)) return;
    await pause(300);
  }
  throw new Error('timeout_' + stage);
}

try {
  await mkdir(join(scratch, 'work'), { recursive: true });
  await writeFile(join(scratch, 'work/note.txt'), 'The color is BLUE.\n');
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  base = 'http://127.0.0.1:' + port;
  child = spawn('claude', [
    '-p', '--plugin-dir', pluginDir, '--model', 'haiku', '--effort', 'low',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--setting-sources', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
    '--tools', 'Read', '--allowedTools', 'Read', '--max-budget-usd', '0.15',
  ], { cwd: join(scratch, 'work'), env: { ...process.env, UVOICE_AUTOSTART: '1', UVOICE_BRIDGE_TOKEN: token, UVOICE_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  childClosed = new Promise(resolve => child.once('close', code => { exitCode = code; resolve(); }));
  child.once('error', () => { exitCode = -1; });
  child.stderr.on('data', data => { stderrBytes += data.length; });
  let buffer = '';
  child.stdout.on('data', data => {
    buffer += data.toString();
    if (buffer.length > 4_000_000) { child.kill('SIGTERM'); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let item; try { item = JSON.parse(line); } catch { continue; }
      if (item.type === 'result') {
        resultCount++;
        evidence.claude.model = Object.keys(item.modelUsage || {})[0] || null;
        evidence.claude.costUsd = item.total_cost_usd;
        evidence.claude.results = resultCount;
        evidence.claude.success = !item.is_error;
      }
    }
  });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Reply exactly READY, then wait for the next request.' } }) + '\n');
  stage = 'claude_ready';
  await waitFor(() => resultCount >= 1, 25_000);
  evidence.checks.helperReady = !!state;
  stage = 'browser_open';
  browserStarted = true;
  await browser('--executable-path', chrome, '--args', [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=' + resolve(wav), '--autoplay-policy=no-user-gesture-required',
  ].join(','), 'open', base + '/#token=' + token);
  // Observe only transport statistics and our synthetic test's captions.
  await browser('eval', "(() => { const Original = window.RTCPeerConnection; window.__voiceSmokePeers = []; window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); window.__voiceSmokePeers.push(this); } }; return 'observer ready'; })()");
  stage = 'voice_connect';
  await browser('click', '#connect');
  await waitFor(s => s?.status?.microphoneReady || s?.status?.phase === 'error', 40_000);
  if (state.status.phase === 'error') throw new Error(state.status.message);
  evidence.checks.codexDatachannelOpen = state.status.remoteDatachannelOpen;
  evidence.checks.syntheticMicrophoneReady = state.status.microphoneReady;
  stage = 'voice_delegate';
  await waitFor(s => s?.delegations?.some(d => d.liveSessionId !== 'offline'), 40_000);
  evidence.checks.voiceDelegated = true;
  stage = 'claude_answer';
  await waitFor(s => /BLUE/i.test(s?.latestFinal?.text || ''), 40_000);
  evidence.checks.claudeReadFile = state.agentEvents.some(e => e.kind === 'tool' && e.tool === 'Read' && e.status === 'completed');
  evidence.checks.claudeAnswerBlue = /BLUE/i.test(state.latestFinal.text);
  stage = 'spoken_answer';
  let observed;
  const until = Math.min(deadline, Date.now() + 25_000);
  while (Date.now() < until) {
    const stats = await browser('eval', "(async () => { const pc = window.__voiceSmokePeers?.at(-1); const stats = pc ? [...(await pc.getStats()).values()] : []; const inbound = stats.filter(s => s.type === 'inbound-rtp' && s.kind === 'audio'); return JSON.stringify({ voiceSaysBlue: [...document.querySelectorAll('#captions .caption')].some(e => /^Voice:/.test(e.textContent) && /blue/i.test(e.textContent)), audioBytes: inbound.reduce((n,s) => n + (s.bytesReceived || 0), 0), audioEnergy: inbound.reduce((n,s) => n + (s.totalAudioEnergy || 0), 0), connected: pc?.connectionState === 'connected' }); })()");
    let value = stats.stdout.trim();
    try { observed = JSON.parse(value); if (typeof observed === 'string') observed = JSON.parse(observed); } catch { observed = undefined; }
    // Comfort-noise packets also have tiny positive energy. Wait for speech.
    if (observed?.voiceSaysBlue && observed.audioEnergy > 0.000001 && observed.audioBytes > 0) break;
    await pause(500);
  }
  evidence.checks.voiceAnswerBlue = observed?.voiceSaysBlue === true;
  evidence.checks.receivedVoiceAudio = observed?.audioBytes > 0 && observed?.audioEnergy > 0.000001;
  evidence.checks.webrtcConnected = observed?.connected === true;
  evidence.transport = observed;
  if (!Object.values(evidence.checks).every(Boolean)) throw new Error('incomplete_pipeline');
  stage = 'mute';
  await browser('click', '#mute');
  await waitFor(s => s?.status?.phase === 'muted', 5000);
  const muteState = await browser('eval', 'window.__voiceSmokePeers.at(-1).getSenders().filter(s => s.track?.kind === "audio").every(s => !s.track.enabled)');
  evidence.checks.mutePausedInput = muteState.stdout.trim() === 'true';
  stage = 'disconnect';
  await browser('click', '#disconnect');
  await waitFor(s => s?.status?.phase === 'idle' && !s.status.liveSessionId, 5000);
  const disconnectState = await browser('eval', 'window.__voiceSmokePeers.at(-1).connectionState === "closed" && !document.querySelector("#connect").disabled');
  evidence.checks.disconnectClosedTransport = disconnectState.stdout.trim() === 'true';
  stage = 'reload';
  await browser('reload');
  const localAccess = await browser('eval', '(async () => { const token = sessionStorage.getItem("uvoice-bridge-token"); const r = await fetch("/state", {headers:{Authorization:"Bearer " + token}}); return r.ok; })()');
  evidence.checks.reloadKeptLocalAccess = localAccess.stdout.trim() === 'true';
  stage = 'reconnect';
  await browser('click', '#connect');
  await waitFor(s => s?.status?.microphoneReady || s?.status?.phase === 'error', 35_000);
  evidence.checks.reconnected = state?.status?.microphoneReady === true;
  await browser('click', '#disconnect');
  await waitFor(s => s?.status?.phase === 'idle' && !s.status.liveSessionId, 5000);
  if (!Object.values(evidence.checks).every(Boolean)) throw new Error('incomplete_pipeline');
  evidence.outcome = 'passed';
} catch (error) {
  // Only local stage names or the helper's sanitized actionable error are stored.
  const message = error?.message || 'smoke_error';
  evidence.failure = { stage, code: /^(timeout_|local_http_|claude_exited|incomplete_pipeline|Codex |The Codex |Could not reach Codex)/.test(message) ? message.slice(0, 240) : 'smoke_error' };
  if (browserStarted) {
    try {
      const page = await browser('eval', 'document.querySelector("#detail").textContent');
      evidence.failure.page = page.stdout.trim().slice(0, 240);
    } catch {}
  }
} finally {
  if (browserStarted) {
    try { await browser('click', '#disconnect'); } catch {}
    try { await browser('close'); } catch {}
  }
  if (child && exitCode === undefined) {
    child.stdin.end();
    await Promise.race([childClosed, pause(4000)]);
    if (exitCode === undefined) {
      try { await local('/shutdown', {}); } catch {}
      child.kill('SIGTERM');
      await Promise.race([childClosed, pause(2000)]);
      if (exitCode === undefined) child.kill('SIGKILL');
    }
  }
  evidence.claude.exitCode = exitCode ?? null;
  evidence.claude.stderrBytes = stderrBytes;
  await writeFile(join(scratch, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence));
process.exitCode = evidence.outcome === 'passed' ? 0 : 1;
