// This file also runs in Node's offline tests; it uses no Node APIs.
function requestText(request) {
  return request.text.trim() + (request.context && request.context.trim() !== request.text.trim() ? '\n\nVoice conversation:\n' + request.context.trim() : '');
}

const terminal = state => ['complete', 'denied', 'cancelled'].includes(state);
const rejected = result => result?.deny !== undefined || result?.drop !== undefined || ['denied', 'rejected', 'error'].includes(result?.status);

// Narrow effects keep the Claude host object at literal $.method call sites in
// register.js, as required by the native mod validator.
export function createController({ submit, append }, emit = () => {}) {
  const requests = new Map();
  let active;
  let starting;
  let generation = 0;
  let closed = false;
  let ingress = [];
  const turns = new Map();
  let speechRevision = 0;

  function receipt(r, state, extra = {}) {
    r.state = state;
    emit({ kind: 'delivery', requestId: r.id, state, mode: r.mode, turnId: r.turnId, ...extra });
  }

  function trim() {
    if (requests.size <= 512) return;
    for (const [id, r] of requests) {
      if (terminal(r.state)) requests.delete(id);
      if (requests.size <= 384) break;
    }
  }

  function valid(r, stamp) {
    return !closed && stamp === generation && requests.get(r.id) === r && !terminal(r.state);
  }

  function finishWrite(r, accepted) {
    r.writePending = false;
    emit({ kind: 'context-delivery', requestId: r.id, accepted });
  }

  function bind(group, turn) {
    if (starting?.group !== group) return;
    starting = undefined;
    for (const r of group) if (!terminal(r.state)) {
      r.turnId = turn.turnId;
      receipt(r, 'accepted');
      if (turn.index >= 0) {
        receipt(r, 'observed', { step: turn.index });
        if (active?.turnId === turn.turnId && r.maySpeak && r.speechRevision === speechRevision) active.maySpeak = true;
      }
      if (turn.completed) receipt(r, turn.completed === 'answer' ? 'complete' : 'cancelled');
    }
    if (turn.completed) continuePending();
  }

  // The reservation lasts until turn.start, not until submit's promise settles:
  // submit can return while queued behind another turn.
  function startRequests(group, continuation = false) {
    const stamp = generation;
    const reservation = { group, id: group[0].id };
    starting = reservation;
    for (const r of group) { r.mode = 'submit'; r.turnId = undefined; receipt(r, 'submitting'); }
    const fresh = group.filter(r => !r.uuid).map(requestText);
    const text = fresh.length ? fresh.join('\n\n') : 'Continue with the new voice direction above.';
    reservation.text = text;
    // Calling through a microtask also catches synchronous host failures.
    void Promise.resolve().then(() => {
      if (closed || stamp !== generation || group.every(r => terminal(r.state))) return;
      for (const r of group) r.writePending = true;
      return submit({ text, asUser: true });
    }).then(result => {
      if (closed || stamp !== generation) {
        for (const r of group) finishWrite(r, !rejected(result) && typeof result?.text === 'string');
        return;
      }
      for (const r of group) r.writePending = false;
      if (rejected(result) || typeof result?.text !== 'string') {
        for (const r of group) if (valid(r, stamp) && r.state !== 'observed') receipt(r, 'denied', { message: 'Claude did not accept the voice request.' });
        if (starting === reservation) starting = undefined;
        continuePending();
      } else {
        for (const r of group) if (valid(r, stamp) && r.state === 'submitting') receipt(r, 'accepted');
      }
    }, () => {
      if (closed || stamp !== generation) { for (const r of group) finishWrite(r, false); return; }
      for (const r of group) r.writePending = false;
      for (const r of group) if (valid(r, stamp) && r.state !== 'observed') receipt(r, 'denied', { message: 'Could not submit the voice request to Claude.' });
      if (starting === reservation) starting = undefined;
      continuePending();
    });
  }

  async function steerRequest(r) {
    const stamp = generation;
    r.mode = 'steer';
    r.turnId = active.turnId;
    r.state = 'appending';
    r.writePending = true;
    try {
      const result = await append({ message: { type: 'user', content: [{ type: 'text', text: requestText(r) }] } });
      r.writePending = false;
      if (!valid(r, stamp)) { finishWrite(r, !rejected(result) && typeof result?.uuid === 'string' && Boolean(result.uuid)); return; }
      // Native append returns the minted row UUID. A hook can decline or swallow
      // the operation, so successful Promise resolution alone is insufficient.
      if (rejected(result) || typeof result?.uuid !== 'string' || !result.uuid) {
        receipt(r, 'denied', { message: 'Claude did not accept the voice context note.' });
        trim();
        return;
      }
      r.uuid = result.uuid;
      r.afterStep = active?.turnId === r.turnId ? active.index : -1;
      receipt(r, 'accepted');
      continuePending();
    } catch {
      r.writePending = false;
      if (!valid(r, stamp)) finishWrite(r, false);
      if (valid(r, stamp)) receipt(r, 'denied', { message: 'Could not append the voice request to Claude.' });
      trim();
    } finally {
      if (!closed && stamp === generation) continuePending();
    }
  }

  function continuePending() {
    if (closed || active || starting) return;
    // Wait for every append to settle so a slow receipt cannot launch another
    // continuation for the same ending turn after its siblings already started.
    if ([...requests.values()].some(r => r.state === 'appending')) return;
    const pending = [...requests.values()].filter(r => r.state === 'accepted' || r.state === 'waiting');
    if (pending.length) startRequests(pending, pending.some(r => r.mode === 'steer'));
  }

  return {
    async delegate(request) {
      if (closed) return { state: 'denied' };
      if (!request || typeof request.id !== 'string' || !request.id || request.id.length > 200 || typeof request.text !== 'string' || !request.text.trim()) throw new Error('Invalid voice request');
      if (requests.has(request.id)) {
        const r = requests.get(request.id);
        receipt(r, r.state);
        return r;
      }
      trim();
      // Bound pending state as well as old IDs if a host stops making progress.
      if (requests.size >= 1024) {
        const r = { id: request.id, state: 'denied' };
        receipt(r, 'denied', { message: 'Too many pending voice requests. Wait for Claude to catch up.' });
        return r;
      }
      const r = { id: request.id, text: request.text.slice(0, 30000), context: request.context, state: 'waiting', maySpeak: request.maySpeak !== false, speechRevision };
      requests.set(r.id, r);
      if (active) await steerRequest(r);
      else if (starting) receipt(r, 'waiting');
      else startRequests([r]);
      return r;
    },
    prompt(e, ownPlugin = 'uvoice') {
      const own = e.origin?.kind === 'plugin' && e.origin.name === ownPlugin;
      const existing = own && ingress.find(item => item.group === starting?.group && item.text === e.text);
      if (existing) return existing;
      const token = { text: e.text, group: own ? starting?.group : undefined };
      ingress.push(token);
      if (ingress.length > 128) ingress.shift();
      if (!own && ['composer', 'bridge', 'sdk'].includes(e.origin?.kind)) this.input('typed', e.text);
      return token;
    },
    promptResult(token, result) {
      if (rejected(result) || typeof result?.text !== 'string') ingress = ingress.filter(item => item !== token);
      else {
        token.text = result.text;
        if (token.group && token.group === starting?.group) {
          const turn = [...turns.values()].find(t => !t.bound && t.text === token.text);
          if (turn) { turn.bound = true; ingress = ingress.filter(item => item !== token); bind(token.group, turn); }
        }
      }
    },
    input(origin, text) {
      speechRevision++;
      if (active) active.maySpeak = false;
      for (const r of requests.values()) r.maySpeak = false;
      if (origin === 'typed') emit({ kind: 'input', origin, text });
    },
    start(e) {
      if (closed || e.agentId) return;
      const index = ingress.findIndex(item => item.text === e.text);
      const input = index >= 0 ? ingress.splice(index, 1)[0] : undefined;
      const turn = { turnId: e.turnId, text: e.text, index: -1, bound: Boolean(input) };
      turns.set(e.turnId, turn);
      if (turns.size > 128) turns.delete(turns.keys().next().value);
      active = { turnId: e.turnId, index: -1, maySpeak: false, speechRevision };
      // A typed prompt can win the race with an idle voice submission. Keep the
      // queued voice reservation for its own turn instead of binding it wrongly.
      if (starting && (input?.group === starting.group || (typeof e.text !== 'string' && !input))) {
        turn.bound = true;
        bind(starting.group, turn);
      }
      emit({ kind: 'turn', status: 'started', turnId: e.turnId, speak: false });
      for (const r of requests.values()) if (r.state === 'waiting') void steerRequest(r);
    },
    step(e) {
      if (closed || e.agentId || (active && active.turnId !== e.turnId)) return;
      active = { ...active, turnId: e.turnId, index: e.index };
      if (turns.has(e.turnId)) turns.get(e.turnId).index = e.index;
      for (const r of requests.values()) {
        if (r.turnId === e.turnId && (r.state === 'accepted' || r.state === 'submitting') && (r.mode === 'submit' || e.index > r.afterStep)) {
          receipt(r, 'observed', { step: e.index });
          if (r.maySpeak && r.speechRevision === speechRevision) active.maySpeak = true;
        }
      }
    },
    complete(e) {
      if (closed || e.agentId || active?.turnId !== e.turnId) return;
      const ids = [];
      const endedNormally = !e.isAborted && (e.reason === undefined || e.reason === 'answer');
      if (turns.has(e.turnId)) turns.get(e.turnId).completed = endedNormally ? 'answer' : 'cancelled';
      for (const r of requests.values()) {
        if (r.turnId === e.turnId && r.state === 'observed') {
          receipt(r, endedNormally ? 'complete' : 'cancelled');
          ids.push(r.id);
        } else if (!endedNormally && !terminal(r.state)) {
          // An explicit stop, refusal or exhausted error must never revive work
          // via a late append callback or a queued continuation.
          receipt(r, 'cancelled', { pendingWrite: Boolean(r.writePending), message: 'Claude stopped before handling this voice request. Please repeat it to try again.' });
        }
      }
      if (!endedNormally) starting = undefined;
      emit({ kind: 'final', text: e.answer ?? '', turnId: e.turnId, reason: e.reason, isAborted: Boolean(e.isAborted), requestIds: ids, speak: Boolean(active.maySpeak) });
      active = undefined;
      trim();
      if (endedNormally) continuePending();
    },
    cancelPending() {
      // Turning voice off leaves Claude's existing work running and keeps its
      // busy state accurate if voice is reopened before that work finishes.
      generation++;
      starting = undefined;
      for (const r of requests.values()) if (!terminal(r.state) && r.state !== 'observed') receipt(r, 'cancelled', { pendingWrite: Boolean(r.writePending) });
      trim();
    },
    reset() { closed = false; generation++; active = undefined; starting = undefined; ingress = []; turns.clear(); requests.clear(); },
    close() { closed = true; generation++; active = undefined; starting = undefined; ingress = []; turns.clear(); requests.clear(); },
    snapshot() { return { active: active && { ...active }, starting: starting?.id, requests: [...requests.values()].map(({ id, state, mode, turnId }) => ({ id, state, mode, turnId })) }; },
  };
}
