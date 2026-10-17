import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { For, Show, createSignal } from 'solid-js';
import { VOICE_END_CONTEXT, VOICE_RPC, VOICE_START_CONTEXT, createTranscriptLedger, seedHistory, voiceBlock } from './voice-state.js';

const root = dirname(fileURLToPath(import.meta.url));
// Opt-in trace for development: event kinds and states only, never transcripts.
const debug = (...parts: unknown[]) => {
  const file = process.env.UVOICE_DEBUG_LOG;
  if (file) try { appendFileSync(file, new Date().toISOString() + ' ' + parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ') + '\n'); } catch { /* Tracing is best effort. */ }
};
const terminal = (state: string) => ['complete', 'cancelled', 'denied'].includes(state);
const labels: Record<string, string> = { starting: 'Starting', connecting: 'Connecting', listening: 'Listening', muted: 'Muted', idle: 'Off', stopping: 'Off', error: 'Error' };

type Request = { id: string; inboxID?: string; state: string; maySpeak: boolean };
type Helper = { url: string; token: string };

// U-voice for OpenCode. The Node helper owns the Codex GPT-Live call and the
// hidden audio host; this plugin binds it to one session. OpenCode's inbox
// does the steering: a prompt starts a turn when idle and joins the next model
// step when busy, so delivery needs no submit/append split.
export default {
  id: 'uvoice',
  setup(context: any) {
    const client = context.client;
    let phase = 'off';
    let sessionID: string | undefined;
    let child: ChildProcess | undefined;
    let helper: Helper | undefined;
    let generation = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let queue: any[] = [];
    let sending = false;
    let modeOn = false; // whether the session last saw <voice_mode state="on">
    let ledger = createTranscriptLedger();
    const requests = new Map<string, Request>();
    const byInbox = new Map<string, Request>();
    let lastText = '';
    let stepText = '';

    const [status, setStatus] = createSignal('');
    const [voiceSession, setVoiceSession] = createSignal<string>();
    const [captions, setCaptions] = createSignal<{ role: string; text: string }[]>([]);
    const rpc = client.rpc(VOICE_RPC);
    let pushTimer: ReturnType<typeof setTimeout> | undefined;
    // Keep the server's copy of undelivered speech current for typed prompts.
    const pushPending = () => {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        if (!sessionID) return;
        const { text, through } = child ? ledger.preview() : { text: '', through: 0 };
        rpc.pending({ sessionID, text, through }).catch((error: unknown) => debug('pending push failed', String(error)));
      }, 120);
    };
    const redraw = () => {
      setCaptions(ledger.pendingCaptions().filter((row: any) => row.text.trim()).slice(-3));
      pushPending();
    };
    const toast = (message: string, variant = 'info') => context.ui.toast.show({ title: 'Voice', message, variant });
    const showStatus = (message?: string) => {
      if (phase === 'off') return setStatus('');
      setStatus('Voice: ' + (labels[phase] || phase) + (phase === 'error' && message ? ' · ' + message : ' · /v off · /m mute'));
    };

    function emit(event: any) {
      debug('emit', event.kind, event.state ?? event.reason ?? '', event.speak ?? '', helper ? '' : '(no helper)');
      if (helper) queue.push(event);
    }

    async function flush() {
      if (!helper || sending || !queue.length) return;
      const target = helper;
      const batch = queue.splice(0, 24);
      sending = true;
      try {
        const response = await fetch(target.url + '/agent-events', { method: 'POST', headers: { Authorization: 'Bearer ' + target.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) });
        if (!response.ok) throw new Error('Voice helper unavailable');
      } catch {
        if (helper === target) queue.unshift(...batch.slice(0, 160 - queue.length));
      } finally { sending = false; }
    }

    function receipt(r: Request, state: string, extra: Record<string, unknown> = {}) {
      r.state = state;
      emit({ kind: 'delivery', requestId: r.id, state, ...extra });
    }

    // Context-only notes (mode switches, speech before typing or voice-off) go
    // in as synthetic messages that do not start a turn by themselves.
    async function note(text: string, description: string) {
      if (!sessionID) return false;
      try {
        const result = await client.session.synthetic({ sessionID, text, description, resume: false, metadata: { uvoice: description } });
        return Boolean(result?.id);
      } catch { return false; }
    }

    async function syncTranscript(reason: string, suffix?: string) {
      const held = ledger.reserve();
      const text = [held ? voiceBlock(reason, held.text) : '', suffix ?? ''].filter(Boolean).join('\n\n');
      if (!text) return;
      const own = ledger;
      if (await note(text, reason === 'voice-off' ? 'voice off' : 'voice ' + reason)) {
        if (held) { const watermark = own.commit(held); if (own === ledger) emit({ kind: 'context', watermark }); }
      } else {
        if (held) own.release(held);
        toast('Voice context could not be saved; its captions stay visible.', 'warning');
      }
      redraw();
    }

    async function delegate(event: any) {
      const existing = requests.get(event.id);
      if (existing) return receipt(existing, existing.state);
      const r: Request = { id: event.id, state: 'submitting', maySpeak: event.maySpeak !== false };
      requests.set(r.id, r);
      const held = ledger.reserve(event.watermark);
      const own = ledger;
      const busy = context.data.session.status(sessionID) === 'running';
      receipt(r, 'submitting', { mode: busy ? 'steer' : 'submit' });
      try {
        const text = voiceBlock('request', held?.text || 'U: ' + String(event.text ?? '').trim());
        const result = await client.session.prompt({ sessionID, text, delivery: 'steer', metadata: { uvoice: r.id } });
        if (!result?.id) throw new Error('Prompt was not admitted.');
        r.inboxID = result.id;
        byInbox.set(result.id, r);
        if (held) { const watermark = own.commit(held); if (own === ledger) emit({ kind: 'context', watermark }); }
        redraw();
        if (r.state === 'submitting') receipt(r, 'accepted', { mode: busy ? 'steer' : 'submit' });
      } catch {
        if (held) own.release(held);
        receipt(r, 'denied', { message: 'OpenCode did not accept the voice request.' });
      }
      trim();
    }

    function trim() {
      if (requests.size <= 256) return;
      for (const [id, r] of requests) {
        if (!terminal(r.state)) continue;
        requests.delete(id);
        if (r.inboxID) byInbox.delete(r.inboxID);
        if (requests.size <= 192) break;
      }
    }

    function silenceOlder() {
      for (const r of requests.values()) r.maySpeak = false;
    }

    function cancelPending() {
      for (const r of requests.values()) if (!terminal(r.state) && r.state !== 'observed') receipt(r, 'cancelled');
    }

    function finish(reason: 'answer' | 'error' | 'aborted') {
      const done = [...requests.values()].filter(r => r.state === 'observed');
      const speak = done.some(r => r.maySpeak);
      const text = lastText;
      lastText = ''; stepText = '';
      if (!done.length) return;
      emit({ kind: 'final', text, reason, isAborted: reason === 'aborted', requestIds: done.map(r => r.id), speak });
      for (const r of done) receipt(r, reason === 'answer' ? 'complete' : 'cancelled');
      if (reason !== 'answer') cancelPending();
    }

    function onHelperEvent(event: any) {
      debug('helper', event.type, event.phase ?? event.state ?? '', event.type === 'error' || event.type === 'status' ? event.message ?? '' : '');
      if (event.type === 'ready' && Number.isInteger(event.port)) {
        helper = { url: 'http://127.0.0.1:' + event.port, token: helperToken };
        phase = 'connecting'; showStatus();
        timer = setInterval(() => void flush(), 250);
      } else if (event.type === 'status') {
        phase = event.phase === 'idle' || event.phase === 'stopping' ? 'off' : event.phase;
        showStatus(event.message);
        if (['listening', 'muted'].includes(event.phase) && !modeOn) {
          modeOn = true;
          void note(VOICE_START_CONTEXT, 'voice on').then(ok => { if (!ok) modeOn = false; });
        }
        if (['idle', 'error', 'stopping'].includes(event.phase)) cancelPending();
      } else if (event.type === 'transcript') {
        ledger.add(event); redraw();
      } else if (event.type === 'input') {
        silenceOlder();
      } else if (event.type === 'delegate') {
        void delegate(event);
      } else if (event.type === 'host.progress' || event.type === 'host.permission' || event.type === 'host.starting') {
        setStatus('Voice setup: ' + String(event.message || 'Starting audio…').replace(/\s+/g, ' ').slice(0, 120) + ' · /v stop');
      } else if (event.type === 'error') {
        phase = 'error'; showStatus(event.message);
        toast(event.message || 'Voice connection failed.', 'error');
      }
    }

    let helperToken = '';
    async function start() {
      const route = context.ui.router.current();
      debug('start', route);
      if (route.type !== 'session') return toast('Open a session first, then run /v.', 'warning');
      if (child) return;
      const stamp = ++generation;
      sessionID = route.sessionID;
      setVoiceSession(sessionID);
      ledger = createTranscriptLedger(); redraw();
      phase = 'starting'; showStatus();
      helperToken = randomBytes(24).toString('hex');
      let seed: unknown[] = [];
      try {
        await context.data.session.message.sync(sessionID).catch(() => {});
        const messages = (context.data.session.message.list(sessionID) ?? []).map((m: any) => ({
          role: m.type,
          text: m.type === 'assistant' ? (m.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n\n') : m.text,
        }));
        seed = seedHistory(messages);
      } catch { /* Project questions can still be delegated. */ }
      if (stamp !== generation) return;
      const env = { ...process.env, UVOICE_BRIDGE_TOKEN: helperToken, UVOICE_CONTEXT_SEED: JSON.stringify(seed) };
      const proc = spawn(process.env.UVOICE_NODE || 'node', [join(root, 'scripts/voice-host.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] });
      child = proc;
      let buffer = '';
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (chunk: string) => {
        if (child !== proc) return;
        buffer += chunk;
        if (buffer.length > 256000) { buffer = ''; return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try { onHelperEvent(JSON.parse(line)); } catch { /* Not a helper event. */ }
        }
      });
      proc.once('error', (error) => {
        debug('spawn error', String(error));
        if (child === proc) { toast('Could not start the voice helper. Node.js 22 or newer is required.', 'error'); void stop(); }
      });
      proc.once('exit', () => { if (child === proc) { void stop(); } });
    }

    async function stop() {
      const old = helper;
      const proc = child;
      generation++;
      child = undefined; helper = undefined; queue = [];
      if (timer) clearInterval(timer); timer = undefined;
      cancelPending();
      if (old) await fetch(old.url + '/shutdown', { method: 'POST', headers: { Authorization: 'Bearer ' + old.token, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1000) }).catch(() => {});
      if (proc && proc.exitCode === null) setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGTERM'); }, 1500).unref?.();
      // Speech not yet delivered and the mode switch reach the session as one note.
      if (modeOn) { await syncTranscript('voice-off', VOICE_END_CONTEXT); modeOn = false; }
      else await syncTranscript('voice-off');
      phase = 'off'; showStatus();
    }

    async function mute() {
      if (!helper || !['listening', 'muted'].includes(phase)) return toast('Voice is not listening yet. Start it with /v.', 'warning');
      try {
        const response = await fetch(helper.url + '/control', { method: 'POST', headers: { Authorization: 'Bearer ' + helper.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'toggle-mute' }) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) return toast(result.error || 'Microphone is not ready.', 'warning');
        toast(result.muted ? 'Microphone muted. Replies remain audible.' : 'Microphone on.');
      } catch { toast('Could not reach the voice helper. Toggle /v to restart.', 'error'); }
    }

    const ours = (event: any) => sessionID && event.data?.sessionID === sessionID;
    const subscriptions = [
      context.data.on('session.inbox.enqueued', (event: any) => {
        if (!ours(event) || !child) return;
        const item = event.data.item;
        if (item?.type !== 'user') return;
        const metadata = item.payload?.metadata ?? {};
        const own = requests.get(metadata.uvoice);
        if (own) { own.inboxID = event.data.inboxID; byInbox.set(event.data.inboxID, own); return; }
        // A typed message: older results stay silent. The server plugin put
        // the speech before it into the prompt, up to uvoiceTyped.
        silenceOlder();
        emit({ kind: 'input', origin: 'typed' });
        if (Number.isSafeInteger(metadata.uvoiceTyped)) {
          const held = ledger.reserve(metadata.uvoiceTyped);
          if (held) emit({ kind: 'context', watermark: ledger.commit(held) });
          redraw();
        }
      }),
      context.data.on('session.inbox.delivered', (event: any) => {
        if (!ours(event)) return;
        const r = byInbox.get(event.data.inboxID);
        if (r && !terminal(r.state)) receipt(r, 'observed');
      }),
      context.data.on('session.inbox.cancelled', (event: any) => {
        if (!ours(event)) return;
        const r = byInbox.get(event.data.inboxID);
        if (r && !terminal(r.state)) receipt(r, 'cancelled');
      }),
      context.data.on('session.step.started', (event: any) => { if (ours(event)) stepText = ''; }),
      context.data.on('session.text.ended', (event: any) => {
        if (!ours(event)) return;
        stepText = [stepText, event.data.text].filter((part: string) => part?.trim()).join('\n\n');
        lastText = stepText;
      }),
      context.data.on('session.execution.succeeded', (event: any) => { if (ours(event)) finish('answer'); }),
      context.data.on('session.execution.failed', (event: any) => { if (ours(event)) finish('error'); }),
      context.data.on('session.execution.interrupted', (event: any) => { if (ours(event)) finish('aborted'); }),
    ];

    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'uvoice.toggle', title: 'Toggle voice', description: 'Talk with this session through Codex GPT-Live', group: 'Voice', palette: true, slash: { name: 'v' },
          run: () => {
            void (child ? stop() : start()).catch(error => {
              debug('toggle failed', String(error?.stack ?? error));
              toast('Voice failed: ' + String(error?.message ?? error), 'error');
            });
          },
        },
        { id: 'uvoice.mute', title: 'Mute voice microphone', group: 'Voice', palette: true, slash: { name: 'm' }, run: () => { void mute(); } },
      ],
    }));

    context.ui.slot({
      append: 'prompt.footer.status',
      render: () => (
        <Show when={status()}>
          <text fg={status().startsWith('Voice: Error') ? context.theme.text.feedback.error.base : context.theme.text.muted} flexShrink={0}>{status()}</text>
        </Show>
      ),
    });

    context.ui.slot({
      append: 'session.composer.top',
      render: (input: { sessionID: string }) => (
        <Show when={captions().length && input.sessionID === voiceSession()}>
          <box flexDirection="column" flexShrink={0}>
            <For each={captions()}>
              {row => <text fg={context.theme.text.muted} wrapMode="none" truncate>{(row.role === 'U' ? 'You: ' : 'Voice: ') + row.text.trim()}</text>}
            </For>
          </box>
        </Show>
      ),
    });

    return async () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      clearTimeout(pushTimer);
      await stop();
    };
  },
};
