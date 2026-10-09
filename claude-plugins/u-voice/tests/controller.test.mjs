import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../hooks/controller.js';

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides = {}) {
  const submits = [], appends = [], events = [];
  const controller = createController({
    submit(args) { submits.push(args); controller.prompt({ text: args.text, origin: { kind: 'plugin', name: 'uvoice' } }); return overrides.submit?.(args) ?? Promise.resolve({ text: args.text }); },
    append(args) { appends.push(args); return overrides.append?.(args) ?? Promise.resolve({ uuid: 'row-' + appends.length }); },
  }, event => events.push(event));
  return { controller, submits, appends, events,
    state(id) { return controller.snapshot().requests.find(r => r.id === id)?.state; },
    begin(id = 't1', text) { controller.start({ turnId: id, ...(text === undefined ? {} : { text }) }); },
    step(index = 0, id = 't1') { controller.step({ turnId: id, index }); },
    end(reason = 'answer', id = 't1') { controller.complete({ turnId: id, reason, answer: 'Done', isAborted: reason === 'aborted' }); },
  };
}
const request = id => ({ id, text: `U: do work ${id}` });

test('a prompt rewritten downstream still binds its voice request even if the turn already started', async () => {
  for (const completed of [false, true]) {
    const events = [];
    let controller;
    controller = createController({
      async submit(args) {
        const token = controller.prompt({ text: args.text, origin: { kind: 'plugin', name: 'uvoice' } });
        controller.start({ text: 'rewritten task', turnId: 'rewritten' });
        controller.step({ turnId: 'rewritten', index: 0 });
        if (completed) controller.complete({ turnId: 'rewritten', answer: 'Done', reason: 'answer' });
        controller.promptResult(token, { text: 'rewritten task' });
        return { text: 'rewritten task' };
      },
      append: async () => ({ uuid: 'unused' }),
    }, e => events.push(e));
    await controller.delegate(request('rewritten')); await tick();
    assert.equal(controller.snapshot().starting, undefined);
    assert.equal(controller.snapshot().requests[0].state, completed ? 'complete' : 'observed');
    if (!completed) {
      controller.complete({ turnId: 'rewritten', answer: 'Done', reason: 'answer' });
      assert.equal(events.find(e => e.kind === 'final').speak, true);
    }
  }
});

test('debounced older requests cannot acquire current speech ownership', async () => {
  const h = harness(); h.controller.input('typed', 'New direction');
  await h.controller.delegate({ ...request('old'), maySpeak: false }); await tick();
  h.begin('late', h.submits[0].text); h.step(0, 'late'); h.end('answer', 'late');
  assert.equal(h.events.find(e => e.kind === 'final').speak, false);
});

test('reserves one idle submission until turn.start even after acceptance', async () => {
  const h = harness();
  await h.controller.delegate(request('a'));
  await tick();
  assert.equal(h.submits.length, 1);
  assert.equal(h.controller.snapshot().starting, 'a');
  await h.controller.delegate(request('b'));
  await h.controller.delegate(request('a'));
  await tick();
  assert.equal(h.submits.length, 1);
  assert.equal(h.state('b'), 'waiting');
  h.begin(); await tick(); h.step();
  assert.equal(h.appends.length, 1);
  assert.equal(h.state('a'), 'observed');
  assert.equal(h.state('b'), 'observed');
  h.end(); await tick();
  assert.equal(h.submits.length, 1);
  assert.deepEqual(h.events.find(e => e.kind === 'final').requestIds, ['a', 'b']);
  assert.equal(h.submits[0].asUser, true);
});

test('busy requests append once and are observed by the following model step', async () => {
  const h = harness(); h.begin(); h.step();
  await h.controller.delegate(request('a'));
  await h.controller.delegate(request('a'));
  assert.equal(h.appends.length, 1);
  assert.equal(h.state('a'), 'accepted');
  h.step(1); h.end(); await tick();
  assert.equal(h.state('a'), 'complete');
  assert.equal(h.submits.length, 0);
});

test('several late directions are appended once and get one content-free continuation', async () => {
  const h = harness(); h.begin(); h.step();
  await h.controller.delegate(request('a'));
  await h.controller.delegate(request('b'));
  h.end(); await tick();
  assert.equal(h.submits.length, 1);
  assert.equal(h.submits[0].text, 'Continue with the new voice direction above.');
  assert.match(h.appends[0].message.content[0].text, /do work a/);
  assert.match(h.appends[1].message.content[0].text, /do work b/);
  assert.equal(h.controller.snapshot().starting, 'a');
  h.begin('t2', h.submits[0].text); h.step(0, 't2'); h.end('answer', 't2'); await tick();
  assert.equal(h.submits.length, 1);
  assert.equal(h.state('a'), 'complete');
  assert.equal(h.state('b'), 'complete');
  assert.deepEqual(h.events.filter(e => e.kind === 'final').at(-1).requestIds, ['a', 'b']);
});

test('slow append completion after final answer joins all late directions once', async () => {
  const pending = deferred();
  const h = harness({ append: args => args.message.content[0].text.includes('do work b') ? pending.promise : Promise.resolve({ uuid: 'a' }) });
  h.begin(); h.step();
  await h.controller.delegate(request('a'));
  const delivery = h.controller.delegate(request('b'));
  h.end(); await tick(); assert.equal(h.submits.length, 0);
  pending.resolve({ uuid: 'b' }); await delivery; await tick();
  assert.equal(h.submits.length, 1);
  assert.equal(h.submits[0].text, 'Continue with the new voice direction above.');
});

test('slow append denial does not strand a previously accepted late request', async () => {
  const pending = deferred();
  const h = harness({ append: args => args.message.content[0].text.includes('do work b') ? pending.promise : Promise.resolve({ uuid: 'a' }) });
  h.begin(); h.step(); await h.controller.delegate(request('a'));
  const delivery = h.controller.delegate(request('b')); h.end();
  pending.resolve({ deny: 'policy' }); await delivery; await tick();
  assert.equal(h.submits.length, 1);
  assert.equal(h.submits[0].text, 'Continue with the new voice direction above.');
  assert.equal(h.state('b'), 'denied');
});

for (const reason of ['aborted', 'error', 'refusal']) test(`${reason} cancels pending steering and never restarts after a slow append`, async () => {
  const pending = deferred(); const h = harness({ append: () => pending.promise });
  h.begin(); h.step(); const delivery = h.controller.delegate(request('a'));
  h.end(reason); pending.resolve({ uuid: 'a' }); await delivery; await tick();
  assert.equal(h.submits.length, 0);
  assert.equal(h.state('a'), 'cancelled');
  await h.controller.delegate(request('a')); assert.equal(h.appends.length, 1);
  await h.controller.delegate(request('retry')); await tick();
  assert.equal(h.submits.length, 1);
});

test('subagent and stale completion events do not release the main turn', async () => {
  const h = harness(); h.begin(); h.step();
  h.controller.step({ turnId: 'child', index: 4, agentId: 'agent' });
  h.controller.complete({ turnId: 'child', agentId: 'agent', reason: 'answer' });
  h.end('answer', 'stale');
  assert.equal(h.controller.snapshot().active.turnId, 't1');
  assert.equal(h.controller.snapshot().active.index, 0);
  assert.equal(h.events.filter(e => e.kind === 'final').length, 0);
  await h.controller.delegate(request('a'));
  assert.equal(h.appends.length, 1); assert.equal(h.submits.length, 0);
});

test('native denial, explicit rejected status, and swallowed append are rejected', async () => {
  for (const response of [{ deny: '' }, { status: 'rejected', uuid: 'a' }, {}, undefined]) {
    const h = harness({ append: () => Promise.resolve(response) }); h.begin();
    await h.controller.delegate(request('a')); h.end(); await tick();
    assert.equal(h.state('a'), 'denied'); assert.equal(h.submits.length, 0);
  }
});

test('submit rejection and synchronous failure release reservation without retrying', async () => {
  for (const submit of [() => Promise.resolve({ drop: '' }), () => { throw new Error('offline'); }]) {
    const h = harness({ submit });
    await h.controller.delegate(request('a')); await tick();
    assert.equal(h.state('a'), 'denied'); assert.equal(h.controller.snapshot().starting, undefined);
    assert.equal(h.submits.length, 1);
  }
});

test('a typed turn does not steal a queued voice submission reservation', async () => {
  const h = harness(); await h.controller.delegate(request('a')); await tick();
  h.begin('typed', 'a typed prompt'); h.step(0, 'typed'); h.end('answer', 'typed'); await tick();
  assert.equal(h.state('a'), 'accepted'); assert.equal(h.controller.snapshot().starting, 'a');
  assert.equal(h.submits.length, 1);
  h.begin('voice', h.submits[0].text); h.step(0, 'voice'); h.end('answer', 'voice'); await tick();
  assert.equal(h.state('a'), 'complete'); assert.equal(h.submits.length, 1);
});

test('close and reset isolate late callbacks from a new generation', async () => {
  const pending = deferred(); const h = harness({ append: () => pending.promise });
  h.begin(); const delivery = h.controller.delegate(request('a'));
  h.controller.close(); h.controller.reset(); h.begin('new');
  pending.resolve({ uuid: 'old' }); await delivery; await tick();
  assert.deepEqual(h.controller.snapshot().requests, []);
  assert.equal(h.controller.snapshot().active.turnId, 'new'); assert.equal(h.submits.length, 0);
});

test('completed IDs remain deduplicated and terminal history stays bounded', async () => {
  const h = harness();
  for (let i = 0; i < 540; i++) {
    await h.controller.delegate(request(String(i))); await tick();
    h.begin('t' + i); h.step(0, 't' + i); h.end('answer', 't' + i);
  }
  await h.controller.delegate(request('539')); await tick();
  assert.equal(h.submits.length, 540);
  assert.ok(h.controller.snapshot().requests.length <= 512);
});

test('turning voice off cancels continuations while preserving running Claude state', async () => {
  const pending = deferred(); let delayed = true;
  const h = harness({ append: () => delayed ? pending.promise : Promise.resolve({ uuid: 'new' }) });
  h.begin(); h.step(); const delivery = h.controller.delegate(request('old'));
  h.controller.cancelPending(); pending.resolve({ uuid: 'old' }); await delivery;
  assert.equal(h.controller.snapshot().active.turnId, 't1');
  assert.equal(h.state('old'), 'cancelled');
  delayed = false; await h.controller.delegate(request('new'));
  h.step(1); h.end(); await tick();
  assert.equal(h.state('new'), 'complete'); assert.equal(h.submits.length, 0);
});

test('typed correction suppresses old voice result, and a later observed voice request owns speech', async () => {
  const h = harness(); await h.controller.delegate(request('a')); await tick();
  h.begin('voice', h.submits[0].text); h.step(0, 'voice');
  h.controller.prompt({ text: 'Actually keep it unchanged', origin: { kind: 'composer' } });
  h.end('answer', 'voice');
  assert.equal(h.events.filter(e => e.kind === 'final').at(-1).speak, false);
  h.begin('typed', 'Actually keep it unchanged'); h.step(0, 'typed');
  h.controller.input('voice'); await h.controller.delegate(request('b'));
  h.step(1, 'typed'); h.end('answer', 'typed');
  assert.equal(h.events.filter(e => e.kind === 'final').at(-1).speak, true);
});

test('a new spoken utterance cannot make an old result speak before its request is observed', async () => {
  const h = harness(); await h.controller.delegate(request('a')); await tick();
  h.begin('voice', h.submits[0].text); h.step(0, 'voice');
  h.controller.input('voice'); await h.controller.delegate(request('b')); h.end('answer', 'voice'); await tick();
  assert.equal(h.events.filter(e => e.kind === 'final').at(-1).speak, false);
  assert.equal(h.submits.length, 2);
});

test('a voice request reaches Claude as one voice block, without repeating the delegation text', async () => {
  const idle = harness();
  await idle.controller.delegate({ id: 'with-context', text: 'Fix the parser', context: 'U: um the parser\nA: Okay.\nU: Fix the parser' });
  await tick();
  assert.equal(idle.submits[0].text, '<voice reason="request">\nU: um the parser\nA: Okay.\nU: Fix the parser\n</voice>');
  const busy = harness();
  busy.begin();
  await busy.controller.delegate({ id: 'no-context', text: 'Keep the API' });
  await tick();
  assert.equal(busy.appends[0].message.content[0].text, '<voice reason="request">\nU: Keep the API\n</voice>');
});
