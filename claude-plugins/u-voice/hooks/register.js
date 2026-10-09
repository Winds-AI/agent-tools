import { createController } from './controller.js';
import { VOICE_SYSTEM_SECTION, createModeContext, createTranscriptLedger, seedHistory, voiceBlock } from './voice-state.js';

export function register(on) {
  let runtime;
  let controller;
  let helper;
  let starting;
  let child;
  let timer;
  let queue = [];
  let phase = 'off';
  let generation = 0;
  let outgoing;
  const instructions = createModeContext();
  let transcript = createTranscriptLedger();
  const transcriptNotes = new Map();
  let captions = [];
  const maxEvents = 160;
  const startupTimeoutMs = 240000;

  function emit(event) {
    if (event.kind === 'delivery' || event.kind === 'context-delivery') {
      const saved = transcriptNotes.get(event.requestId);
      if (saved && (['accepted', 'observed'].includes(event.state) || event.accepted === true)) {
        event.watermark = saved.ledger.commit(saved.note);
        transcriptNotes.delete(event.requestId);
        if (saved.ledger === transcript) runtime.redraw();
      } else if (saved && !event.pendingWrite && (['denied', 'cancelled'].includes(event.state) || event.accepted === false)) {
        saved.ledger.release(saved.note);
        transcriptNotes.delete(event.requestId);
      }
      if (event.kind === 'context-delivery') event = { kind: 'context', watermark: event.watermark };
    }
    if (!helper && !starting) return;
    const previous = queue.at(-1);
    if (event.kind === 'text' && previous?.kind === 'text' && previous.turnId === event.turnId && previous.text.length < 2400) previous.text += event.text;
    else queue.push(event);
    if (queue.length > maxEvents) {
      const disposable = queue.findIndex(e => e.kind === 'text' || e.kind === 'tool');
      if (disposable >= 0) queue.splice(disposable, 1);
    }
  }

  function addTranscript(event) {
    transcript.add(event);
    if (typeof event.utteranceId !== 'string' || typeof event.text !== 'string') return;
    const row = captions.find(c => c.id === event.utteranceId);
    if (row) row.final = Boolean(event.final);
    else captions.push({ id: event.utteranceId, final: Boolean(event.final) });
    captions = captions.slice(-4);
    runtime.redraw();
  }

  async function syncTranscript(reason) {
    const ledger = transcript;
    if (ledger.flight) await ledger.flight;
    const note = ledger.reserve();
    if (!note) return;
    const flight = (async () => {
      try {
        const result = await runtime.append({ message: { type: 'user', content: [{ type: 'text', text: voiceBlock(reason, note.text) }] } });
        if (result?.uuid) {
          const watermark = ledger.commit(note);
          if (ledger === transcript) { runtime.redraw(); emit({ kind: 'context', watermark }); }
        }
        else { ledger.release(note); throw new Error('Voice conversation was not saved.'); }
      } catch (error) { ledger.release(note); throw error; }
    })();
    ledger.flight = flight;
    try { await flight; } finally { if (ledger.flight === flight) ledger.flight = undefined; }
  }

  async function flush() {
    if (!helper || outgoing || !queue.length) return;
    const target = helper;
    const stamp = generation;
    const flight = {};
    outgoing = flight;
    const batch = queue.splice(0, 24);
    try {
      const result = await runtime.fetch(target.url + '/agent-events', { method: 'POST', headers: { Authorization: 'Bearer ' + target.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) });
      if (!result.ok) throw new Error('Voice helper unavailable');
    } catch {
      if (stamp === generation && helper === target) {
        queue.unshift(...batch);
        if (queue.length > maxEvents) queue = queue.slice(-maxEvents);
        runtime.status('Voice helper disconnected. Claude continues working.');
      }
    } finally { if (outgoing === flight) outgoing = undefined; }
  }

  async function openBrowser() {
    if (!helper) return;
    const url = helper.url + '/#token=' + encodeURIComponent(helper.token);
    try {
      await runtime.run([runtime.node, runtime.root + '/scripts/open-browser.mjs', url]);
    } catch { runtime.toast('Browser did not open. Use /uvoice url to copy its local address.'); }
  }

  function settleReady(task, error) {
    if (task.settled) return;
    task.settled = true;
    task.timeout?.cancel();
    if (error) task.reject(error);
    else task.resolve();
  }

  function releaseChild(task) {
    if (!task || task.released) return;
    task.released = true;
    task.kickoff?.cancel();
    task.timeout?.cancel();
    // Native process.spawn kills its child when its stream is released. Do not
    // wait for a blocked pull here: stopping voice must remain immediate.
    try { void Promise.resolve(task.stream?.return?.()).catch(() => {}); } catch { /* Already released. */ }
  }

  async function launch(mode = 'hidden') {
    if (helper) { if (mode === 'open') await openBrowser(); return; }
    if (starting) return starting;
    const stamp = ++generation;
    phase = 'starting';
    const token = runtime.bridgeToken || Array.from(crypto.getRandomValues(new Uint8Array(24)), x => x.toString(16).padStart(2, '0')).join('');
    const env = { UVOICE_BRIDGE_TOKEN: token, ...(runtime.authFile ? { UVOICE_CODEX_AUTH_FILE: runtime.authFile } : {}), ...(runtime.port ? { UVOICE_PORT: runtime.port } : {}), ...(runtime.syntheticWav ? { UVOICE_TEST_AUDIO_WAV: runtime.syntheticWav } : {}) };
    const task = { stamp, token, mode, settled: false, released: false };
    task.closed = new Promise(resolve => { task.resolveClosed = resolve; });
    const ready = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    // Both autostart and command callers still receive this rejection. Attaching
    // a handler immediately also covers stop before either caller starts waiting.
    void ready.catch(() => {});
    starting = ready;
    child = task;
    task.timeout = runtime.after(startupTimeoutMs, () => {
      if (task.settled || child !== task || stamp !== generation) return;
      generation++;
      child = undefined; starting = undefined; phase = 'error';
      controller?.cancelPending();
      settleReady(task, new Error('Voice setup did not finish within four minutes.'));
      releaseChild(task);
      runtime.status('Voice setup timed out. Use /uvoice to retry.');
    });
    task.kickoff = runtime.after(0, async () => {
      if (child !== task || stamp !== generation || task.released) return;
      let buffer = '';
      let savingPrevious = false;
      try {
        // Do not erase unsaved captions when reconnecting after a failed save.
        if (transcript.pendingCaptions().length) {
          savingPrevious = true;
          await syncTranscript('voice-off');
          if (transcript.pendingCaptions().length) throw new Error('Voice context is still pending.');
          savingPrevious = false;
        }
        let seed = [];
        try { seed = seedHistory(await runtime.messages()); } catch { /* Project questions can still be delegated. */ }
        if (child !== task || stamp !== generation || task.released) return;
        env.UVOICE_CONTEXT_SEED = JSON.stringify(seed);
        transcript = createTranscriptLedger(); captions = [];
        task.stream = runtime.spawn({ argv: [runtime.node, runtime.root + (mode === 'hidden' ? '/scripts/voice-host.mjs' : '/helper/server.mjs')], cwd: runtime.root, env });
        for await (const chunk of task.stream) {
          if (stamp !== generation || child !== task) { if (task.stopping) continue; break; }
          const text = chunk.text ?? chunk.data ?? chunk.stdout;
          const source = chunk.stream ?? chunk.kind;
          if (typeof text !== 'string' || (source && source !== 'stdout')) continue;
          buffer += text;
          if (buffer.length > 256000) throw new Error('Oversized helper output');
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            let event; try { event = JSON.parse(line); } catch { continue; }
            if (event.type === 'ready' && Number.isInteger(event.port) && event.port > 0 && event.port <= 65535 && !task.settled) {
              helper = { url: 'http://127.0.0.1:' + event.port, token };
              phase = 'ready'; starting = undefined;
              timer = runtime.every(250, flush);
              runtime.status(mode === 'hidden' ? 'Voice: Connecting · /v stop · /m mute' : 'Voice helper ready.');
              settleReady(task);
              if (mode === 'open') void openBrowser();
            } else if (event.type === 'delegate') {
              if (!controller.snapshot().requests.some(r => r.id === event.id)) {
                const note = transcript.reserve(event.watermark);
                if (note) transcriptNotes.set(event.id, { ledger: transcript, note });
                void controller.delegate({ ...event, context: note?.text }).catch(() => emit({ kind: 'delivery', requestId: event.id, state: 'denied', message: 'Invalid voice request.' }));
              } else void controller.delegate(event);
            } else if (event.type === 'transcript') {
              addTranscript(event);
            } else if (event.type === 'input') {
              controller.input('voice');
            } else if (event.type === 'host.progress' || event.type === 'host.permission' || event.type === 'host.starting') {
              const message = String(event.message || (event.type === 'host.starting' ? 'Starting hidden audio host…' : 'Setting up audio…')).replace(/\s+/g, ' ').slice(0, 160);
              runtime.status('Voice setup: ' + message + ' · /v stop');
            } else if (event.type === 'status') {
              phase = event.phase;
              instructions.set(['listening', 'muted'].includes(event.phase));
              runtime.redraw();
              if (['idle', 'error', 'stopping'].includes(event.phase)) controller?.cancelPending();
              const labels = { connecting: 'Connecting', listening: 'Listening', muted: 'Muted', idle: 'Off', stopping: 'Off', error: 'Error' };
              runtime.status('Voice: ' + (labels[event.phase] || event.phase) + (event.phase === 'error' ? ' · ' + event.message : ' · /v toggle · /m mute'));
            } else if (event.type === 'error') { phase = 'error'; instructions.set(false); runtime.redraw(); runtime.toast(event.message || 'Voice connection failed.'); }
          }
        }
        if (stamp === generation && child === task) {
          child = undefined; helper = undefined; starting = undefined; phase = 'off'; timer?.cancel();
          controller?.cancelPending();
          instructions.set(false); runtime.redraw();
          settleReady(task, new Error('Voice helper exited before starting.'));
          runtime.status('Voice off. Use /uvoice to restart.');
        }
      } catch {
        if (stamp === generation && child === task) {
          child = undefined; helper = undefined; starting = undefined; phase = 'error'; timer?.cancel();
          controller?.cancelPending();
          instructions.set(false); runtime.redraw();
          const message = savingPrevious ? 'Previous voice conversation has not been saved yet. Its captions are still visible; retry /v.' : 'Could not start the voice helper. Node.js 22 or newer is required.';
          settleReady(task, new Error(message));
          runtime.toast(savingPrevious ? message : 'Could not start the voice helper.');
        }
      } finally { releaseChild(task); task.resolveClosed(); }
    });
    return ready;
  }

  async function stop() {
    const old = helper;
    const task = child;
    if (task) task.stopping = true;
    const stamp = ++generation;
    timer?.cancel(); timer = undefined;
    child = undefined; helper = undefined; phase = 'off'; queue = []; starting = undefined; outgoing = undefined;
    instructions.set(false); runtime.redraw();
    controller?.cancelPending();
    if (task) settleReady(task, new Error('Voice startup was cancelled.'));
    // Ask a ready helper to close the browser call, then release its process.
    // A hung HTTP response must not hold the command or child indefinitely.
    let shutdownTimeout;
    const shutdown = old ? runtime.fetch(old.url + '/shutdown', {
      method: 'POST', headers: { Authorization: 'Bearer ' + old.token, 'Content-Type': 'application/json' }, body: '{}',
    }).then(result => {
      if (!result.ok) throw new Error('Voice helper refused shutdown.');
    }).catch(() => {}) : Promise.resolve();
    // Saving context shares the teardown deadline. New helper events are already
    // invalidated, and a late successful append keeps ownership of its ledger.
    const drain = old ? syncTranscript('voice-off').catch(() => {
      runtime.toast('Some voice conversation could not be saved; its captions are still visible.');
    }) : Promise.resolve();
    const deadline = new Promise(resolve => { shutdownTimeout = runtime.after(1000, resolve); });
    const gracefullyClosed = shutdown.then(() => old && task?.mode === 'hidden' && task.stream ? task.closed : undefined);
    try { await Promise.race([Promise.all([gracefullyClosed, drain]), deadline]); }
    finally { shutdownTimeout?.cancel(); releaseChild(task); }
    if (stamp === generation) runtime.status('Voice off.');
  }

  on('session.start', async ($, e, next) => {
    runtime = {
      root: $.plugin.root,
      node: await $.env.get('UVOICE_NODE') || 'node',
      bridgeToken: await $.env.get('UVOICE_BRIDGE_TOKEN'),
      authFile: await $.env.get('UVOICE_CODEX_AUTH_FILE'),
      port: await $.env.get('UVOICE_PORT'),
      syntheticWav: await $.env.get('UVOICE_TEST_AUDIO_WAV'),
      fetch: (url, init) => $.http.fetch(url, init),
      run: argv => $.process.run(argv),
      spawn: input => $.process.spawn(input),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
      status: text => $.ui.status(text),
      toast: text => $.ui.toast(text),
      redraw: () => $.ui.invalidate('ui.render'),
      messages: () => $.session.messages(),
      append: args => $.session.append(args),
    };
    controller = createController({ submit: async args => {
      // The native host excludes this module on its own submission. Register
      // ownership before calling it, rather than relying on prompt re-entry.
      const token = controller.prompt({ ...args, origin: { kind: 'plugin', name: $.plugin.name } }, $.plugin.name);
      try { const result = await $.prompt.submit(args); controller.promptResult(token, result); return result; }
      catch (error) { controller.promptResult(token, { drop: 'failed' }); throw error; }
    }, append: args => $.session.append(args) }, emit);
    await $.command.register({ name: 'v', description: 'Toggle voice on or off', immediate: true });
    await $.command.register({ name: 'm', description: 'Mute or unmute your voice microphone', immediate: true });
    await $.command.register({ name: 'uvoice', description: 'Voice status and diagnostics', argumentHint: '[start|stop|status|open|url]', immediate: true });
    if (await $.env.get('UVOICE_AUTOSTART') === '1') void launch('manual').catch(() => {});
    return next(e);
  });

  async function startHidden() {
    try { await launch(); return { text: 'Voice connecting. /v stops voice; /m mutes your microphone.' }; }
    catch (error) { return { text: error instanceof Error ? error.message : 'Voice could not start.' }; }
  }

  async function muteMicrophone() {
    if (!helper || !['listening', 'muted'].includes(phase)) return { text: 'Voice is not listening yet. Start it with /v.' };
    const target = helper;
    const stamp = generation;
    try {
      const response = await runtime.fetch(target.url + '/control', { method: 'POST', headers: { Authorization: 'Bearer ' + target.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'toggle-mute' }) });
      if (stamp !== generation || target !== helper) return { text: 'Voice stopped.' };
      const result = JSON.parse(response.text || '{}');
      if (!response.ok) return { text: result.error || 'Microphone is not ready.' };
      return { text: result.muted ? 'Muting microphone. Replies remain audible.' : 'Unmuting microphone.' };
    } catch { return { text: 'Could not reach the voice helper. Toggle /v to restart.' }; }
  }

  on('command.run', { command: 'v' }, async () => {
    if (starting || (helper && !['idle', 'error', 'off'].includes(phase))) { await stop(); return { text: 'Voice off.' }; }
    if (helper || child) await stop();
    return startHidden();
  });
  on('command.run', { command: 'm' }, async () => muteMicrophone());

  on('command.run', { command: 'uvoice' }, async ($, e) => {
    const action = e.args.trim();
    if (action === 'stop') { await stop(); return { text: 'Voice stopped.' }; }
    if (action === 'mute') return muteMicrophone();
    if (action === 'status') return { text: 'Voice: ' + phase + (controller?.snapshot().active ? '. Claude is working.' : '.') };
    if (action === 'url') {
      if (!helper) return { text: 'Start voice mode with /uvoice first.' };
      await $.ui.copy(helper.url + '/#token=' + helper.token);
      return { text: 'Voice page address copied. Paste it into your browser.' };
    }
    if (action === 'open') {
      try { await launch('open'); } catch (error) { return { text: error instanceof Error ? error.message : 'Voice helper could not start.' }; }
      return { text: 'Voice diagnostics opened.' };
    }
    if (action && action !== 'start') return { text: 'Use /v to toggle voice, /m to mute, or /uvoice status.' };
    if (helper && ['idle', 'error'].includes(phase)) await stop();
    return startHidden();
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const pending = transcript.pendingCaptions().filter(row => row.text.trim());
    if (e.props.hasSurvey || !pending.length) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const rows = pending.slice(-Math.max(1, Math.min(3, e.props.maxRows - 1)));
    return Box({ flexDirection: 'column', children: [await next(e), ...rows.map(row => Text({ dimColor: Boolean(captions.find(c => c.id === row.utteranceId)?.final), wrap: 'truncate-end', children: (row.role === 'U' ? 'You: ' : 'Voice: ') + row.text.trim() }))] });
  });
  // Constant text after the cache boundary: present whether or not voice is on,
  // so toggling voice never rewrites the system prompt.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e);
    return { ...result, sections: [...result.sections, { id: 'uvoice:voice-mode', text: VOICE_SYSTEM_SECTION, scope: 'session' }] };
  });
  on('prompt.submit', async ($, e, next) => {
    const token = controller?.prompt(e, $.plugin.name);
    if (['composer', 'bridge', 'sdk'].includes(e.origin.kind)) {
      try { await syncTranscript('typed'); } catch { runtime.toast('Voice context could not be saved before this typed request.'); }
    }
    const note = instructions.reserve();
    try {
      const result = await next(note ? { ...e, context: [...(e.context ?? []), note.text] } : e);
      controller?.promptResult(token, result);
      if (note) {
        if (result?.context?.includes(note.text)) instructions.commit(note);
        else instructions.release(note);
      }
      return result;
    } catch (error) { controller?.promptResult(token, { drop: 'failed' }); if (note) instructions.release(note); throw error; }
  });
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e);
    if (result.block || result.preventContinuation) return result;
    const note = instructions.reserve();
    if (!note) return result;
    instructions.commit(note);
    return { ...result, additionalContext: [...(result.additionalContext ?? []), note.text] };
  });
  on('turn.start', async ($, e, next) => { controller?.start(e); return next(e); });
  on('turn.step', async function* ($, e, next) {
    controller?.step(e);
    const stream = next(e);
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) return item.value;
        if (!e.agentId && item.value.kind === 'text') emit({ kind: 'text', text: item.value.text, turnId: e.turnId, step: e.index, final: false, speak: Boolean(controller?.snapshot().active?.maySpeak) });
        yield item.value;
      }
    } finally { await stream.return?.(); }
  });
  on('tool.call', async ($, e, next) => {
    if (!e.agentId) emit({ kind: 'tool', tool: e.tool, status: 'started', turnId: controller?.snapshot().active?.turnId });
    try {
      const result = await next(e);
      if (!e.agentId) emit({ kind: 'tool', tool: e.tool, status: result.isError || result.deny ? 'error' : 'completed', turnId: controller?.snapshot().active?.turnId });
      if (e.agentId || result.deny !== undefined) return result;
      const note = instructions.reserve();
      if (!note) return result;
      instructions.commit(note);
      return { ...result, context: [...(result.context ?? []), note.text] };
    } catch (error) {
      if (!e.agentId) emit({ kind: 'tool', tool: e.tool, status: 'error', turnId: controller?.snapshot().active?.turnId });
      throw error;
    }
  });
  on('turn.complete', async ($, e, next) => { controller?.complete(e); return next(e); });
  on('session.end', async ($, e, next) => {
    controller?.close();
    await stop();
    // clear/resume keep this loaded module; session.start does not run again.
    if (e.reason === 'clear' || e.reason === 'resume') controller?.reset();
    instructions.reset(); transcript.reset(); captions = []; transcriptNotes.clear();
    return next(e);
  });
}
