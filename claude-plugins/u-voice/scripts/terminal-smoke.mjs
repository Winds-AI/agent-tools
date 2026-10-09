#!/usr/bin/env node
// Subscription-backed terminal controls and synthetic audio, isolated fixtures.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createPortServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wav = process.env.UVOICE_SMOKE_WAV;
if (!wav) throw new Error('Set UVOICE_SMOKE_WAV to synthesized speech asking to read note.txt and report its color.');
const scratch = resolve(root, '.scratch/rewrite-terminal-smoke');
const work = resolve(scratch, 'work');
const observer = resolve(scratch, 'observer');
await mkdir(work, { recursive: true });
await mkdir(resolve(observer, 'hooks'), { recursive: true });
await mkdir(resolve(observer, '.claude-plugin'), { recursive: true });
await writeFile(resolve(work, 'note.txt'), 'The color is BLUE.\n');
const token = randomBytes(32).toString('hex');
const evidence = { startedAt: new Date().toISOString(), checks: {}, finals: [], captions: { user: 0, voice: 0, voiceSaysBlue: false, permanentLogs: 0 }, requestedModel: 'sonnet', mainModels: [], usageModels: [], costUsd: 0 };
let child, state, buffer = '', exitCode, stderrBytes = 0, stage = 'prepare';
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const deadline = Date.now() + 90_000;
const observe = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const event = JSON.parse(raw || '{}');
  if (event.type === 'caption') {
    if (event.text.startsWith('You:')) evidence.captions.user++;
    if (event.text.startsWith('Voice:')) { evidence.captions.voice++; if (/blue/i.test(event.text)) evidence.captions.voiceSaysBlue = true; }
  }
  if (event.type === 'permanent-caption') evidence.captions.permanentLogs++;
  if (event.type === 'final') evidence.finals.push(event);
  response.end('{}');
});
await new Promise(resolveListen => observe.listen(0, '127.0.0.1', resolveListen));
const sink = 'http://127.0.0.1:' + observe.address().port;
await writeFile(resolve(observer, '.claude-plugin/plugin.json'), '{"name":"terminal-fixture-observer"}');
await writeFile(resolve(observer, 'hooks/hooks.json'), '{"modules":["./register.js"]}');
await writeFile(resolve(observer, 'hooks/register.js'), `export function register(on) {
  // Print mode has no terminal render loop; native tests cover AbovePrompt.
  // Observe helper transcripts arriving at the plugin, not permanent UI logs.
  on('process.spawn', async function* ($, e, next) {
    const stream = next(e);
    let buffer = '';
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) return item.value;
        if (item.value.stream === 'stdout' && typeof item.value.text === 'string') {
          buffer += item.value.text;
          let end;
          while ((end = buffer.indexOf('\\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            let event; try { event = JSON.parse(line); } catch { continue; }
            if (event.type === 'transcript' && event.final) await $.http.fetch(${JSON.stringify(sink)}, { method: 'POST', body: JSON.stringify({ type: 'caption', text: (event.role === 'U' ? 'You: ' : 'Voice: ') + event.text }) });
          }
        }
        yield item.value;
      }
    } finally { await stream.return?.(); }
  });
  on('ui.log', async ($, e, next) => {
    if (/^(You|Voice):/.test(e.text)) await $.http.fetch(${JSON.stringify(sink)}, { method: 'POST', body: JSON.stringify({ type: 'permanent-caption' }) });
    return next(e);
  });
  on('http.fetch', async ($, e, next) => {
    if (e.url.endsWith('/agent-events') && e.init?.body) {
      const events = JSON.parse(e.init.body).events || [];
      for (const event of events) if (event.kind === 'final') await $.http.fetch(${JSON.stringify(sink)}, { method: 'POST', body: JSON.stringify({ type: 'final', speak: event.speak, requestCount: event.requestIds?.length || 0, saysBlue: /blue/i.test(event.text || ''), typedMarker: /TEXT_OK/.test(event.text || '') }) });
    }
    return next(e);
  });
}`);
const reserve = createPortServer();
await new Promise(resolveListen => reserve.listen(0, '127.0.0.1', resolveListen));
const port = reserve.address().port;
await new Promise(resolveClose => reserve.close(resolveClose));
const base = 'http://127.0.0.1:' + port;
const command = text => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
async function poll() {
  try {
    const response = await fetch(base + '/state', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1000) });
    if (response.ok) state = await response.json();
  } catch {}
}
async function waitFor(predicate, ms) {
  const end = Math.min(deadline, Date.now() + ms);
  while (Date.now() < end) {
    if (exitCode !== undefined) throw new Error('claude_exited');
    await poll();
    if (state?.status?.phase === 'error') throw new Error('voice_error');
    if (predicate()) return;
    await pause(200);
  }
  throw new Error('timeout_' + stage);
}
let warmupDone = false;
const totalTimeout = setTimeout(() => child?.kill('SIGTERM'), 90_000);
try {
  child = spawn('claude', ['-p', '--plugin-dir', root, '--plugin-dir', observer, '--model', 'sonnet', '--effort', 'low', '--restricted', '--tools', 'Read', '--allowedTools', 'Read', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--max-budget-usd', '0.20'], { cwd: work, env: { ...process.env, UVOICE_AUTOSTART: '0', UVOICE_BRIDGE_TOKEN: token, UVOICE_PORT: String(port), UVOICE_TEST_AUDIO_WAV: resolve(wav) }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('close', code => { exitCode = code; });
  child.stderr.on('data', data => { stderrBytes += data.length; });
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'system' && event.subtype === 'init') evidence.effectiveModel = event.model;
      if (event.type === 'assistant' && event.message?.model && !evidence.mainModels.includes(event.message.model)) evidence.mainModels.push(event.message.model);
      if (event.type === 'result' && event.total_cost_usd !== undefined) {
        evidence.costUsd = event.total_cost_usd; evidence.usageModels = Object.keys(event.modelUsage || {});
        if (/READY/.test(event.result || '')) warmupDone = true;
      }
    }
  });
  command('This is a normal typed project thread. Reply exactly READY and wait.');
  stage = 'warmup'; await waitFor(() => warmupDone, 20_000);
  command('/v'); stage = 'connect'; await waitFor(() => state?.status?.microphoneReady, 35_000);
  evidence.checks.connectedThroughV = true;
  stage = 'voice_task'; await waitFor(() => evidence.finals.some(f => f.saysBlue && f.speak && f.requestCount === 1), 30_000);
  evidence.checks.voiceDelegationReadFixture = state.agentEvents.some(e => e.kind === 'tool' && e.tool === 'Read' && e.status === 'completed');
  evidence.checks.voiceResultSpeakable = true;
  stage = 'captions'; await waitFor(() => evidence.captions.voiceSaysBlue, 20_000);
  evidence.checks.userTranscriptReachedPlugin = evidence.captions.user > 0;
  evidence.checks.spokenAnswerTranscriptReachedPlugin = evidence.captions.voiceSaysBlue;
  command('/m'); stage = 'mute'; await waitFor(() => state?.status?.microphoneMuted, 5000); evidence.checks.mute = true;
  command('Reply exactly TEXT_OK. This typed request should be answered normally.');
  stage = 'typed'; await waitFor(() => evidence.finals.some(f => f.typedMarker && !f.speak && f.requestCount === 0), 15_000); evidence.checks.typedReplySilent = true;
  command('/m'); stage = 'unmute'; await waitFor(() => state?.status?.phase === 'listening' && !state.status.microphoneMuted, 5000); evidence.checks.unmute = true;
  command('/v'); stage = 'stop';
  let gone = false;
  for (let i = 0; i < 25; i++) {
    try { await fetch(base + '/health', { signal: AbortSignal.timeout(400) }); } catch { gone = true; break; }
    await pause(200);
  }
  evidence.checks.stop = gone;
  evidence.checks.noPermanentCaptionLogs = evidence.captions.permanentLogs === 0;
} catch (error) {
  evidence.failure = { stage, code: /^(timeout_|claude_exited|voice_error)/.test(error.message) ? error.message : 'driver_error' };
  if (state?.status?.phase === 'error') evidence.failure.message = state.status.message;
} finally {
  clearTimeout(totalTimeout);
  if (child && exitCode === undefined) {
    try { await fetch(base + '/shutdown', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1000) }); } catch {}
    child.stdin.end();
    for (let i = 0; i < 20 && exitCode === undefined; i++) await pause(100);
    if (exitCode === undefined) { child.kill('SIGTERM'); await pause(500); }
    if (exitCode === undefined) child.kill('SIGKILL');
  }
  observe.closeAllConnections(); await new Promise(resolveClose => observe.close(resolveClose));
  evidence.exitCode = exitCode; evidence.stderrBytes = stderrBytes;
  evidence.durationMs = Date.now() - Date.parse(evidence.startedAt);
  evidence.outcome = !evidence.failure && Object.values(evidence.checks).every(Boolean) ? 'passed' : 'issues_found';
  await writeFile(resolve(scratch, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence));
process.exitCode = evidence.outcome === 'passed' ? 0 : 1;
