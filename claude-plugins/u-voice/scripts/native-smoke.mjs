#!/usr/bin/env node
// Actual Claude hooks, deterministic local model/audio fixtures, no paid calls.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = resolve(root, '.scratch/rewrite-native-smoke');
const work = resolve(scratch, 'work');
await mkdir(work, { recursive: true });
const evidence = { modelCalls: 0, requests: [], finals: [], seeds: [], results: [], prompts: [], deliveries: [], turns: [], checks: {} };
let child, buffer = '', stderrBytes = 0, stderr = '', exitCode, firstSystem, originalMessages;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, data]) => [key, normalize(data)]));
  if (value.role && typeof value.content === 'string') result.content = [{ type: 'text', text: value.content }];
  return result;
};
const command = text => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
function sse(response, model, content, stopReason) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (type, fields) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n');
  send('message_start', { message: { id: 'msg_fixture_' + evidence.requests.length, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 0 } } });
  content.forEach((block, index) => {
    send('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
    send('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 } });
  send('message_stop', {}); response.end();
}
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 2_000_000) { response.writeHead(413); response.end(); return; } }
  const body = JSON.parse(raw || '{}');
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/fixture-prompt') { evidence.prompts.push(body); response.end('{}'); return; }
  if (path === '/fixture-turn') { evidence.turns.push(body); response.end('{}'); return; }
  if (path === '/fixture-ready') {
    evidence.seeds.push({ hasCurrentThread: body.seed.includes('REWRITE_WARMUP'), hasTypedFollowup: body.seed.includes('TYPED_AFTER_STOP') });
    if (evidence.seeds.length === 1) setTimeout(() => command('REWRITE_INITIAL: selected color is RED. Run sleep 2, then report the color.'), 150);
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ idle: evidence.seeds.length === 2 })); return;
  }
  if (path === '/fixture-events') {
    for (const event of body.events ?? []) if (event.kind === 'delivery') evidence.deliveries.push(event);
    for (const event of body.events ?? []) if (event.kind === 'final') {
      evidence.finals.push({ text: event.text, speak: event.speak, requests: event.requestIds?.length ?? 0 });
      if (event.text === 'BUSY_FINISHED') { command('/v'); command('TYPED_AFTER_STOP: continue normally.'); }
      if (event.text === 'IDLE_VOICE_FINISHED') command('TYPED_WITH_VOICE: reply through text.');
      if (event.text === 'TYPED_FINISHED') { command('/v'); child.stdin.end(); }
    }
    response.end('{}'); return;
  }
  if (path.endsWith('/messages/count_tokens')) { response.end('{"input_tokens":100}'); return; }
  if (!path.endsWith('/messages')) { response.writeHead(404); response.end('{}'); return; }
  const messages = body.messages ?? [];
  if (!JSON.stringify(messages).includes('REWRITE_WARMUP')) { sse(response, body.model, [{ type: 'text', text: 'OK' }], 'end_turn'); return; }
  const index = evidence.requests.length;
  if (!index) { firstSystem = hash(body.system); originalMessages = normalize(messages); }
  const marker = text => messages.flatMap(m => JSON.stringify(m.content).includes(text) ? [m.role] : []);
  evidence.requests.push({ index, sameSystem: hash(body.system) === firstSystem, historyPreserved: originalMessages.every((m, i) => hash(m) === hash(normalize(messages[i]))), on: marker('Voice mode is now attached'), off: marker('Voice mode is now off'), constraints: marker('KEEP_API_FIXTURE'), wrappers: marker('Carry the user').length + marker('U-voice delegated request').length + marker('fixture-internal-id').length });
  console.log(JSON.stringify({ request: index, on: evidence.requests[index].on, off: evidence.requests[index].off }));
  if (!index) sse(response, body.model, [{ type: 'text', text: 'WARMUP_FINISHED' }], 'end_turn');
  else if (index === 1) {
    sse(response, body.model, [{ type: 'tool_use', id: 'tool_fixture', name: 'Bash', input: { command: 'sleep 2', description: 'Wait in the isolated fixture' } }], 'tool_use');
  } else sse(response, body.model, [{ type: 'text', text: ['BUSY_FINISHED', 'TYPED_STOP_FINISHED', 'IDLE_VOICE_FINISHED', 'TYPED_FINISHED'][index - 2] ?? 'UNEXPECTED' }], 'end_turn');
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const endpoint = 'http://127.0.0.1:' + server.address().port;
const fixture = resolve(scratch, 'node-fixture.mjs');
await writeFile(fixture, `#!${process.execPath}
import { createServer } from 'node:http';
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
let delegated = false;
function delegate(idle) {
  if (delegated) return; delegated = true;
  const text = idle ? 'Summarize the current result' : 'Change selected color to BLUE. KEEP_API_FIXTURE';
  send({ type: 'input' });
  send({ type: 'transcript', role: 'U', utteranceId: 'fixture-u', text, delta: text, sequence: 1 });
  send({ type: 'transcript', role: 'U', utteranceId: 'fixture-u', text, final: true });
  send({ type: 'delegate', id: 'fixture-internal-id-' + (idle ? 'idle' : 'busy'), text: idle ? 'Summarize the current result' : 'Choose BLUE', watermark: 1, maySpeak: true });
}
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  if (request.headers.authorization !== 'Bearer ' + process.env.UVOICE_BRIDGE_TOKEN) { response.writeHead(401); response.end(); return; }
  if (request.url === '/shutdown') { response.end('{}'); server.close(); setTimeout(() => process.exit(), 25); return; }
  if (request.url === '/agent-events') {
    const body = JSON.parse(raw);
    if (body.events.some(e => e.kind === 'tool' && e.status === 'started')) delegate(false);
    await fetch(${JSON.stringify(endpoint + '/fixture-events')}, { method: 'POST', body: raw });
    response.end('{}'); return;
  }
  response.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
send({ type: 'ready', port: server.address().port }); send({ type: 'status', phase: 'listening' });
const result = await fetch(${JSON.stringify(endpoint + '/fixture-ready')}, { method: 'POST', body: JSON.stringify({ seed: process.env.UVOICE_CONTEXT_SEED || '' }) }).then(r => r.json());
if (result.idle) setTimeout(() => delegate(true), 100);
`);
await chmod(fixture, 0o700);
const observer = resolve(scratch, 'observer');
await mkdir(resolve(observer, '.claude-plugin'), { recursive: true });
await mkdir(resolve(observer, 'hooks'), { recursive: true });
await writeFile(resolve(observer, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture-observer' }));
await writeFile(resolve(observer, 'hooks/hooks.json'), '{"modules":["./register.js"]}');
await writeFile(resolve(observer, 'hooks/register.js'), `export function register(on) { on('prompt.submit', async ($, e, next) => { await $.http.fetch(${JSON.stringify(endpoint + '/fixture-prompt')}, { method: 'POST', body: JSON.stringify({ origin: e.origin, text: e.text.slice(0,80), context: e.context?.length }) }); const result = await next(e); await $.http.fetch(${JSON.stringify(endpoint + '/fixture-prompt')}, { method: 'POST', body: JSON.stringify({ origin: e.origin, text: 'TRACE', trace: next.trace }) }); return result; }); on('turn.start', async ($, e, next) => { await $.http.fetch(${JSON.stringify(endpoint + '/fixture-turn')}, { method: 'POST', body: JSON.stringify(e) }); return next(e); }); }`);
const timeout = setTimeout(() => { evidence.failure = 'deadline'; child?.kill('SIGTERM'); }, 35_000);
try {
  child = spawn('claude', ['-p', '--plugin-dir', root, '--plugin-dir', observer, '--model', 'sonnet', '--effort', 'low', '--restricted', '--tools', 'Bash,Read', '--allowedTools', 'Bash(sleep *)', 'Read', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence'], { cwd: work, env: { ...process.env, ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: 'fixture-token', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', UVOICE_NODE: fixture, UVOICE_AUTOSTART: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', data => { stderrBytes += data.length; stderr += data; });
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'result') evidence.results.push(String(event.result).slice(0, 240));
      if (event.type === 'result' && event.result === 'WARMUP_FINISHED') command('/v');
      if (event.type === 'result' && event.result === 'TYPED_STOP_FINISHED') command('/v');
    }
  });
  const closed = new Promise(resolveClose => child.on('close', code => { exitCode = code; resolveClose(); }));
  command('REWRITE_WARMUP: this is the existing project thread. Reply briefly.');
  await closed;
  const [warmup, first, busy, stopped, idle, typed] = evidence.requests;
  evidence.checks = {
    completedSixModelSteps: evidence.requests.length === 6,
    stableSystem: evidence.requests.length === 6 && evidence.requests.every(r => r.sameSystem),
    historyPreserved: evidence.requests.length === 6 && evidence.requests.every(r => r.historyPreserved),
    noRepeatedWrapper: evidence.requests.every(r => !r.wrappers),
    nativeModeOn: busy?.on.length === 1 && busy.on[0] === 'system',
    constraintDeliveredOnce: busy?.constraints.length === 1 && typed?.constraints.length === 1,
    nativeModeOff: stopped?.off.length === 1 && stopped.off[0] === 'system',
    priorModesRetained: typed?.on.length === 2 && typed.off.length === 1,
    seededExistingThread: evidence.seeds.length === 2 && evidence.seeds.every(s => s.hasCurrentThread) && evidence.seeds[1].hasTypedFollowup,
    busyResultSpoken: evidence.finals.some(f => f.text === 'BUSY_FINISHED' && f.speak && f.requests === 1),
    idleResultSpoken: evidence.finals.some(f => f.text === 'IDLE_VOICE_FINISHED' && f.speak && f.requests === 1),
    typedResultSilent: evidence.finals.some(f => f.text === 'TYPED_FINISHED' && !f.speak && f.requests === 0),
  };
} catch { evidence.failure = 'driver_error'; child?.kill('SIGTERM'); }
finally {
  clearTimeout(timeout); server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
  evidence.exitCode = exitCode; evidence.stderrBytes = stderrBytes;
  evidence.runtimeErrors = stderr.split('\n').filter(line => /uvoice|hook|invalid|Error|TypeError/i.test(line)).map(line => line.slice(0, 300));
  await writeFile(resolve(scratch, 'fixture-stderr.txt'), stderr);
  evidence.outcome = !evidence.failure && Object.values(evidence.checks).every(Boolean) ? 'passed' : 'issues_found';
  await writeFile(resolve(scratch, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence));
process.exitCode = evidence.outcome === 'passed' ? 0 : 1;
