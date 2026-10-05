import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../hooks/register.js';

const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function stream() {
  const queued = [];
  let pull;
  let done = false;
  return {
    returned: 0,
    next() {
      if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
      if (done) return Promise.resolve({ done: true });
      return new Promise(resolve => { pull = resolve; });
    },
    push(event) {
      const value = { stream: 'stdout', text: JSON.stringify(event) + '\n' };
      if (pull) { const resolve = pull; pull = undefined; resolve({ value, done: false }); }
      else queued.push(value);
    },
    return() { this.returned++; done = true; pull?.({ done: true }); pull = undefined; return Promise.resolve({ done: true }); },
    finish() { done = true; pull?.({ done: true }); pull = undefined; },
    [Symbol.asyncIterator]() { return this; },
  };
}
async function harness() {
  const hooks = new Map(), timers = [], intervals = [], children = [], fetches = [], statuses = [], submits = [], commands = [], logs = [], appends = [], spawns = [];
  const on = (name, ...args) => hooks.set(name === 'command.run' ? name + ':' + args[0].command : name, args.at(-1));
  register(on);
  const timer = (ms, fn, list) => {
    const value = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } };
    list.push(value); return value;
  };
  const $ = {
    plugin: { root: '/fake', name: 'uvoice' },
    env: { get: async name => name === 'UVOICE_BRIDGE_TOKEN' ? 'x'.repeat(40) : undefined },
    clock: { after: (ms, fn) => timer(ms, fn, timers), every: (ms, fn) => timer(ms, fn, intervals) },
    command: { register: async command => commands.push(command) },
    http: { fetch: async (url, init) => { fetches.push({ url, init }); if (url.endsWith('/shutdown')) children.at(-1)?.finish(); return { ok: true, text: JSON.stringify({ muted: true }) }; } },
    process: { run: async () => ({}), spawn: input => { spawns.push(input); const value = stream(); children.push(value); return value; } },
    ui: { status: text => statuses.push(text), toast: () => {}, copy: async () => {}, log: text => logs.push(text), invalidate: () => {}, resolve: () => ({ Box: props => ({ type: 'Box', props }), Text: props => ({ type: 'Text', props }) }) },
    prompt: { submit: async args => { submits.push(args); return args; } },
    session: { append: async args => { appends.push(args); return { uuid: 'row-' + appends.length }; }, messages: async () => [{ role: 'user', text: 'Existing task: fix the parser', toolUses: [] }] },
  };
  const next = async e => e;
  await hooks.get('session.start')($, {}, next);
  return {
    $, hooks, timers, intervals, children, fetches, statuses, submits, commands, logs, appends, spawns,
    command: (args, name = 'uvoice') => hooks.get('command.run:' + name)($, { args }, next),
    hook: (name, e, downstream = next) => hooks.get(name)($, e, downstream),
    kickoff() { const timer = timers.findLast(t => t.ms === 0 && !t.cancelled); const running = timer.fn(); void running.catch(() => {}); return running; },
    timeout() { return timers.findLast(t => t.ms === 15000 && !t.cancelled).fn(); },
  };
}

test('stop before scheduled spawn settles launch and cancels kickoff', async () => {
  const h = await harness();
  const launching = h.command('start');
  await h.command('stop');
  assert.match((await launching).text, /cancelled/i);
  assert.equal(h.children.length, 0);
  assert.ok(h.timers.find(t => t.ms === 0).cancelled);
});

test('stop before ready releases the outstanding process stream', async () => {
  const h = await harness(); const launching = h.command('start');
  const background = h.kickoff(); await tick();
  await h.command('stop'); await background;
  assert.match((await launching).text, /cancelled/i);
  assert.equal(h.children[0].returned, 1);
});

test('startup timeout releases child and allows retry', async () => {
  const h = await harness(); const launching = h.command('start');
  const background = h.kickoff(); await tick(); h.timeout(); await background;
  assert.match((await launching).text, /15 seconds/);
  assert.equal(h.children[0].returned, 1);
  const retry = h.command('start'); h.kickoff(); await tick();
  h.children[1].push({ type: 'ready', port: 4567 });
  assert.match((await retry).text, /connecting/);
  await h.command('stop');
});

test('ready helper shutdown uses required JSON headers and releases process', async () => {
  const h = await harness(); const launching = h.command('start');
  const background = h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  await h.command('stop'); await background;
  const request = h.fetches.find(f => f.url.endsWith('/shutdown'));
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(request.init.body, '{}');
  assert.equal(h.children[0].returned, 1);
});

test('hung shutdown is bounded by deadline and still releases process', async () => {
  const h = await harness(); const launching = h.command('start');
  const background = h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  h.$.http.fetch = () => new Promise(() => {});
  const stopping = h.command('stop'); await tick();
  await h.timers.findLast(t => t.ms === 1000 && !t.cancelled).fn();
  await stopping; await background;
  assert.equal(h.children[0].returned, 1);
});

test('stop immediately rejects new helper work even when transcript saving hangs', async () => {
  const h = await harness(); const launching = h.command('start');
  const background = h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  h.children[0].push({ type: 'status', phase: 'listening' });
  h.children[0].push({ type: 'transcript', utteranceId: 'u1', role: 'U', text: 'Preserve this constraint', delta: 'Preserve this constraint', sequence: 1 }); await tick();
  let resolveAppend;
  h.$.session.append = args => { h.appends.push(args); return new Promise(resolve => { resolveAppend = resolve; }); };
  h.$.http.fetch = (url, init) => { h.fetches.push({ url, init }); return new Promise(() => {}); };
  const stopping = h.command('stop'); await tick();
  h.children[0].push({ type: 'delegate', id: 'late', text: 'Must not run' }); await tick();
  assert.ok(h.fetches.some(f => f.url.endsWith('/shutdown')));
  assert.equal(h.submits.length, 0);
  assert.deepEqual(h.logs, ['You: Preserve this constraint']);
  await h.timers.findLast(t => t.ms === 1000 && !t.cancelled).fn();
  await stopping; await background;
  assert.equal(h.children[0].returned, 1);
  resolveAppend({ uuid: 'late-save' }); await tick();
  await h.hook('prompt.submit', { text: 'Typed follow-up', origin: { kind: 'composer' } });
  assert.equal(h.appends.length, 1, 'late successful save is not duplicated');
});

test('cancelled in-flight delegation retains transcript ownership until the write settles', async () => {
  const h = await harness(); const launching = h.command('start'); h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  await h.hook('turn.start', { turnId: 'busy', text: 'Typed task' });
  let resolveAppend;
  h.$.session.append = args => { h.appends.push(args); return new Promise(resolve => { resolveAppend = resolve; }); };
  h.children[0].push({ type: 'transcript', utteranceId: 'u1', role: 'U', text: 'Keep my API', delta: 'Keep my API', sequence: 1 });
  h.children[0].push({ type: 'delegate', id: 'busy-voice', text: 'Fix parser', watermark: 1 }); await tick();
  await h.command('stop');
  assert.equal(h.appends.length, 1);
  resolveAppend({ uuid: 'already-saved' }); await tick();
  await h.hook('prompt.submit', { text: 'Typed next', origin: { kind: 'composer' } });
  assert.equal(h.appends.length, 1);
  assert.equal(h.submits.length, 0);
});

test('clear resets controller because native session.start will not fire again', async () => {
  const h = await harness();
  await h.hook('session.end', { reason: 'clear' });
  const launching = h.command('start'); const background = h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  h.children[0].push({ type: 'delegate', id: 'new', text: 'U: new task' }); await tick();
  assert.equal(h.submits.length, 1);
  await h.command('stop'); await background;
});

test('v and m are immediate controls, and v toggles a running helper off', async () => {
  const h = await harness();
  assert.ok(h.commands.some(c => c.name === 'v' && c.immediate));
  assert.ok(h.commands.some(c => c.name === 'm' && c.immediate));
  assert.match((await h.command('', 'm')).text, /not listening/);
  const launching = h.command('', 'v'); const background = h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  h.children[0].push({ type: 'status', phase: 'listening', message: 'Listening' }); await tick();
  assert.match((await h.command('', 'm')).text, /Muting/);
  const request = h.fetches.find(f => f.url.endsWith('/control'));
  assert.deepEqual(JSON.parse(request.init.body), { action: 'toggle-mute' });
  assert.match((await h.command('', 'v')).text, /off/);
  await background;
  assert.equal(h.children[0].returned, 1);
});

test('v during startup cancels rather than opening a second audio host', async () => {
  const h = await harness(); const launching = h.command('', 'v');
  await h.command('', 'v');
  assert.match((await launching).text, /cancelled/);
  assert.equal(h.children.length, 0);
});

test('late mute response cannot report success after voice stops', async () => {
  const h = await harness(); const launching = h.command('', 'v'); const background = h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  h.children[0].push({ type: 'status', phase: 'listening', message: 'Listening' }); await tick();
  let release;
  const originalFetch = h.$.http.fetch;
  h.$.http.fetch = (url, init) => url.endsWith('/control') ? new Promise(resolve => { release = resolve; }) : originalFetch(url, init);
  const mute = h.command('', 'm'); await tick(); await h.command('', 'v');
  release({ ok: true, text: '{"muted":true}' });
  assert.match((await mute).text, /stopped/);
  await background;
});

test('captions render in terminal while only delivered speech enters model context', async () => {
  const h = await harness(); const launching = h.command('start'); h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  h.children[0].push({ type: 'status', phase: 'listening' });
  h.children[0].push({ type: 'transcript', utteranceId: 'u1', role: 'U', text: 'Fix the parser', delta: 'Fix the parser', sequence: 1 }); await tick();
  const tree = await h.hook('ui.render', { component: 'AbovePrompt', props: { hasSurvey: false, maxRows: 4 } }, async () => null);
  assert.match(JSON.stringify(tree), /You: Fix the parser/);
  assert.equal(h.submits.length, 0); assert.equal(h.appends.length, 0);
  h.children[0].push({ type: 'transcript', utteranceId: 'u1', role: 'U', text: 'Fix the parser', final: true }); await tick();
  assert.deepEqual(h.logs, ['You: Fix the parser']);
  h.children[0].push({ type: 'delegate', id: 'internal-id', text: 'Fix it', watermark: 1 }); await tick();
  assert.equal(h.submits.length, 1);
  assert.match(h.submits[0].text, /Fix the parser/);
  assert.doesNotMatch(h.submits[0].text, /internal-id|Carry the user|delegated request/);
  await h.hook('prompt.submit', { text: 'Typed follow-up', origin: { kind: 'composer' } });
  assert.equal(h.appends.length, 0, 'accepted delegation committed this transcript exactly once');
  await h.command('stop');
});

test('start and end instructions append only on transitions, with typed context saved once', async () => {
  const h = await harness(); const launching = h.command('start'); h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  assert.match(h.spawns[0].env.UVOICE_CONTEXT_SEED, /Existing task/);
  assert.equal(h.hooks.has('prompt.compose'), false);
  h.children[0].push({ type: 'status', phase: 'listening' }); await tick();
  const input = { text: 'Typed', origin: { kind: 'composer' } };
  const first = await h.hook('prompt.submit', input);
  assert.match(first.context[0], /Voice mode is now attached/);
  assert.equal((await h.hook('prompt.submit', input)).context, undefined);
  h.children[0].push({ type: 'status', phase: 'muted' }); await tick();
  assert.equal((await h.hook('prompt.submit', input)).context, undefined, 'mute changes no model instruction');
  h.children[0].push({ type: 'transcript', utteranceId: 'u1', role: 'U', text: 'Keep the API', delta: 'Keep the API', sequence: 1 }); await tick();
  await h.hook('prompt.submit', input);
  assert.equal(h.appends.length, 1); assert.match(h.appends[0].message.content[0].text, /Keep the API/);
  await h.hook('prompt.submit', input); assert.equal(h.appends.length, 1);
  await h.command('stop');
  const after = await h.hook('prompt.submit', input);
  assert.match(after.context[0], /Voice mode is now off/);
  assert.equal((await h.hook('prompt.submit', input)).context, undefined);
});

test('mode transition at a running tool boundary preserves downstream context and retries a dropped prompt', async () => {
  const h = await harness(); const launching = h.command('start'); h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  h.children[0].push({ type: 'status', phase: 'listening' }); await tick();
  await h.hook('prompt.submit', { text: 'Dropped', origin: { kind: 'composer' } }, async () => ({ drop: 'No' }));
  const result = await h.hook('tool.call', { tool: 'Read' }, async () => ({ context: ['existing reminder'], output: 'fixture', isError: false }));
  assert.equal(result.output, 'fixture'); assert.equal(result.context[0], 'existing reminder');
  assert.match(result.context[1], /Voice mode is now attached/);
  assert.equal((await h.hook('tool.call', { tool: 'Read' }, async () => ({ output: 'again' }))).context, undefined);
  await h.command('stop');
});

test('idle self-submission owns its turn without native prompt-hook re-entry and uses turn-entry context', async () => {
  const h = await harness(); const launching = h.command('start'); h.kickoff(); await tick();
  h.children[0].push({ type: 'ready', port: 4567 }); await launching;
  h.children[0].push({ type: 'status', phase: 'listening' });
  h.children[0].push({ type: 'delegate', id: 'idle', text: 'Read the fixture' }); await tick();
  const context = await h.hook('classic.UserPromptSubmit', { prompt: 'Read the fixture' }, async () => ({ additionalContext: ['existing context'] }));
  assert.equal(context.additionalContext[0], 'existing context');
  assert.match(context.additionalContext[1], /Voice mode is now attached/);
  assert.equal((await h.hook('classic.UserPromptSubmit', {})).additionalContext, undefined);
  await h.hook('turn.start', { text: h.submits[0].text, turnId: 'idle-turn' });
  const chunks = h.hook('turn.step', { turnId: 'idle-turn', index: 0 }, async function* () { yield { kind: 'text', text: 'Done' }; });
  for await (const _ of chunks) {}
  await h.hook('turn.complete', { turnId: 'idle-turn', reason: 'answer', answer: 'Done' });
  await h.intervals[0].fn();
  const events = JSON.parse(h.fetches.find(f => f.url.endsWith('/agent-events')).init.body).events;
  assert.ok(events.some(e => e.kind === 'final' && e.speak && e.requestIds.includes('idle')));
  await h.command('stop');
});
