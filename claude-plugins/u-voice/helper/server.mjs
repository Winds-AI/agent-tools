import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createLiveCall, makeInitialItems } from "./call.mjs";
import { Conversation, cleanText, contextChunks } from "./conversation.mjs";
import { safeError, VoiceError } from "./errors.mjs";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_REQUEST_TEXT = 20_000;
const MAX_FINAL_REFERENCE = 1_000;
const RING_SIZE = 40;
const MAX_CANCELLED_CALLS = 500;
const MAX_PENDING_DELEGATIONS = 1_024;
const MAX_TERMINAL_DELEGATIONS = 512;
const FRONTEND_FAILURES = new Map([
  ["microphone_denied", "Microphone permission denied. Allow microphone access for the voice host in your system settings."],
  ["microphone_unavailable", "Microphone unavailable. Check that an input device is connected and not in use by another application."],
  ["connection_failed", "Voice connection failed. Toggle /v off, then on to reconnect."],
  ["playback_failed", "Voice playback failed. Check your audio output device, then toggle /v off and on."],
]);
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

const MAIN_PAGE = new URL("./public/", import.meta.url);

function boundedPush(list, value, max = RING_SIZE) {
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string" || !candidate || !expected) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  const digestMatches = timingSafeEqual(a, b);
  return digestMatches && Buffer.byteLength(candidate) === Buffer.byteLength(expected);
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function headerUrl(value, protocol = "http:") {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return new URL(protocol + "//" + value);
  } catch {
    return undefined;
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

function cleanIdentifier(value, max = 160) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned && cleaned.length <= max ? cleaned : undefined;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function taskTextFromDelegation(item) {
  const direct = [item?.task, item?.text, item?.content_text].find(
    (value) => typeof value === "string" && value.trim(),
  );
  return cleanText(direct ?? textFromContent(item?.content)).trim().slice(0, MAX_REQUEST_TEXT);
}

function normalizeSafeTool(value) {
  return cleanText(String(value ?? "tool")).replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) || "tool";
}

function safeStatusText(value) {
  if (typeof value !== "string") return "";
  return cleanText(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1600);
}

const MAX_SPOKEN_RESULT = 600;

/** The first paragraph of Claude's answer, which the system prompt asks it to write for speech. */
function spokenSummary(value) {
  if (typeof value !== "string") return "";
  const paragraph = value.split(/\n\s*\n/).find((part) => part.trim()) ?? "";
  const text = safeStatusText(paragraph);
  if (text.length <= MAX_SPOKEN_RESULT) return text;
  const cut = text.slice(0, MAX_SPOKEN_RESULT);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return sentenceEnd > 0 ? cut.slice(0, sentenceEnd + 1) : cut;
}

function redactLikelySecrets(value) {
  return String(value)
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*)["']?[^\s,"']+/gi, "$1[redacted]");
}

function clientEvent(type) {
  return { type };
}

function contextSeed() {
  try {
    const items = JSON.parse(process.env.UVOICE_CONTEXT_SEED ?? '[]');
    return Array.isArray(items) ? items.slice(-24).filter(item => item?.type === 'message' && ['user', 'assistant'].includes(item.role) && Array.isArray(item.content)).map(item => ({ type: 'message', role: item.role, content: item.content.filter(part => typeof part.text === 'string').map(part => ({ type: item.role === 'user' ? 'input_text' : 'output_text', text: cleanText(part.text).slice(-6000) })) })) : [];
  } catch { return []; }
}

/**
 * Create the authenticated localhost bridge. Tests inject callFactory and
 * stdout so no credential file or Live request is needed.
 */
export function createHelperServer({
  token = process.env.UVOICE_BRIDGE_TOKEN,
  port = Number(process.env.UVOICE_PORT ?? 0),
  callFactory = createLiveCall,
  stdout = (line) => process.stdout.write(line),
  onLiveSend = () => {},
  initialItems = contextSeed(),
  delegationDelayMs = 1200,
  captionDelayMs = 1200,
} = {}) {
  if (typeof token !== "string" || token.length < 24) {
    throw new VoiceError("UVOICE_BRIDGE_TOKEN must be a random token with at least 24 characters.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new VoiceError("UVOICE_PORT must be between 0 and 65535.");
  }

  const state = {
    phase: "idle",
    message: "Ready to connect.",
    currentSession: undefined,
    pendingConnect: undefined,
    controlRevision: 0,
    stopping: false,
    lastDelegatedWatermark: 0,
    conversation: new Conversation(),
    latestFinal: "",
    latestFinalMeta: undefined,
    activeCallController: undefined,
    activeCallCallId: undefined,
    cancelledCallIds: new Set(),
    delegationByRequest: new Map(),
    delegationByLiveId: new Map(),
    statusEvents: [],
    agentEvents: [],
    receipts: [],
    outboundEvents: [],
    streamClients: new Set(),
    pendingLiveEvents: [],
    speechGeneration: 0,
    caption: undefined,
    captionTimer: undefined,
    transcriptEvents: new Set(),
    port: undefined,
  };

  function emitStdout(event) {
    try {
      stdout(JSON.stringify(event) + "\n");
    } catch {
      // stdout transport failure must not reveal request, auth, or upstream data.
    }
  }

  function broadcast(event) {
    const wire = "data: " + JSON.stringify(event) + "\n\n";
    for (const response of state.streamClients) {
      try {
        response.write(wire);
      } catch {
        state.streamClients.delete(response);
      }
    }
  }

  function publishStatus(phase, message, sessionId = state.currentSession?.id) {
    state.phase = phase;
    state.message = message;
    const event = { type: "status", phase, message };
    if (sessionId) event.liveSessionId = sessionId;
    boundedPush(state.statusEvents, { phase, message, at: Date.now() }, 20);
    emitStdout(event);
    broadcast(event);
  }

  function authorized(request) {
    const value = request.headers.authorization ?? "";
    const match = /^Bearer ([^\s]+)$/i.exec(value);
    return !!match && tokenMatches(match[1], token);
  }

  function checkHostAndOrigin(request) {
    const host = headerUrl(request.headers.host);
    if (!host || !isLoopbackHost(host.hostname)) return false;
    if (host.port && Number(host.port) !== state.port) return false;
    if (!host.port && state.port !== 80) return false;

    const originHeader = request.headers.origin;
    if (originHeader === undefined) return true;
    if (typeof originHeader !== "string") return false;
    let origin;
    try {
      origin = new URL(originHeader);
    } catch {
      return false;
    }
    return (
      origin.protocol === "http:" &&
      isLoopbackHost(origin.hostname) &&
      Number(origin.port || 80) === state.port &&
      !origin.username &&
      !origin.password
    );
  }

  function stateSnapshot() {
    return {
      status: {
        phase: state.phase,
        message: state.message,
        liveSessionId: state.currentSession?.id,
        remoteDatachannelOpen: !!state.currentSession?.remoteOpen,
        microphoneReady: !!state.currentSession?.micReady,
        microphoneMuted: !!state.currentSession?.muted,
        desiredMicrophoneMuted: !!state.currentSession?.desiredMuted,
      },
      statusEvents: state.statusEvents.slice(-20),
      agentEvents: state.agentEvents.slice(-20).map((event) => ({
        ...event,
        ...(typeof event.text === "string" ? { text: redactLikelySecrets(event.text) } : {}),
      })),
      outboundEvents: state.outboundEvents.slice(-20),
      lastDelegatedWatermark: state.lastDelegatedWatermark,
      delegations: [...state.delegationByRequest.values()].slice(-20).map((record) => ({
        id: record.id,
        liveSessionId: record.liveSessionId,
        delegationId: record.delegationId,
        state: record.state,
        attempts: record.attempts,
        watermark: record.watermark,
      })),
      receipts: state.receipts.slice(-20),
      latestFinal: state.latestFinalMeta && {
        ...state.latestFinalMeta,
        text: redactLikelySecrets(state.latestFinalMeta.text),
      },
    };
  }

  function markCallCancelled(callId) {
    if (!callId) return;
    state.cancelledCallIds.add(callId);
    while (state.cancelledCallIds.size > MAX_CANCELLED_CALLS) {
      state.cancelledCallIds.delete(state.cancelledCallIds.values().next().value);
    }
  }

  function makeControl(action, fields = {}) {
    return { type: "control", action, controlId: randomUUID(), revision: ++state.controlRevision, ...fields };
  }

  function clearSessionControls(session) {
    if (state.pendingConnect?.controlId === session?.connectControlId) state.pendingConnect = undefined;
  }

  async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { status: 413 });
      chunks.push(chunk);
    }
    if (!size) return {};
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("invalid json"), { status: 400 });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw Object.assign(new Error("invalid json object"), { status: 400 });
    }
    return value;
  }

  function streamEvent(event, speechGeneration) {
    if (speechGeneration !== undefined && speechGeneration !== state.speechGeneration) return false;
    if (state.currentSession?.remoteOpen && !state.currentSession.closed) {
      const record = { type: "live.send", liveSessionId: state.currentSession.id, event };
      boundedPush(state.outboundEvents, { type: event.type, liveSessionId: state.currentSession.id, at: Date.now() }, 40);
      try {
        onLiveSend(record);
      } catch {}
      broadcast(record);
      return true;
    }
    if (state.currentSession && !state.currentSession.closed && state.pendingLiveEvents.length < 100) {
      state.pendingLiveEvents.push({ sessionId: state.currentSession.id, event, speechGeneration });
      return true;
    }
    return false;
  }

  function flushPendingLiveEvents(sessionId) {
    const stillPending = [];
    for (const pending of state.pendingLiveEvents) {
      if (pending.sessionId === sessionId) streamEvent(pending.event, pending.speechGeneration);
      else if (pending.sessionId !== sessionId) stillPending.push(pending);
    }
    state.pendingLiveEvents = stillPending;
  }

  function emitDelegation(record) {
    record.state = "pending";
    record.attempts++;
    record.lastSentAt = Date.now();
    emitStdout({
      type: "delegate",
      id: record.id,
      text: record.text,
      liveSessionId: record.liveSessionId,
      delegationId: record.delegationId,
      watermark: record.watermark,
      maySpeak: record.speechGeneration === state.speechGeneration,
    });
    broadcast({
      type: "delegate",
      id: record.id,
      liveSessionId: record.liveSessionId,
      delegationId: record.delegationId,
    });
  }

  function addDelegation({ id, text, liveSessionId, delegationId, watermark = 0, kind = "live", deferred = false }) {
    const record = {
      id,
      text,
      liveSessionId,
      delegationId,
      watermark,
      kind,
      state: "pending",
      accepted: false,
      attempts: 0,
      createdAt: Date.now(),
      speechGeneration: state.speechGeneration,
    };
    state.delegationByRequest.set(id, record);
    if (kind === "live") state.delegationByLiveId.set(liveSessionId + "\u0000" + delegationId, record);
    pruneTerminalDelegations();
    if (!deferred) emitDelegation(record);
    return record;
  }

  function finishCaption() {
    clearTimeout(state.captionTimer); state.captionTimer = undefined;
    const caption = state.caption;
    if (!caption || caption.final) return;
    caption.final = true;
    emitStdout({ type: 'transcript', ...caption, final: true });
  }

  function invalidateSpeech() {
    state.speechGeneration++;
    state.pendingLiveEvents = state.pendingLiveEvents.filter(item => item.speechGeneration === undefined);
  }

  function settleDelegation(record) {
    clearTimeout(record.timer); record.timer = undefined;
    if (!state.currentSession || state.currentSession.closed || record.liveSessionId !== state.currentSession.id || record.emitted) return;
    const fragments = state.conversation.fragments.filter(f => f.sequence > state.lastDelegatedWatermark);
    record.watermark = fragments.at(-1)?.sequence ?? state.lastDelegatedWatermark;
    // Full transcript is delivered separately by the native ledger. The task
    // remains readable and does not silently consume its spoken constraints.
    record.text = record.task || state.conversation.rows(fragments).filter(row => row.role === 'U').map(row => row.text.trim()).join('\n');
    if (!record.text.trim()) { record.state = 'denied'; return; }
    record.emitted = true;
    emitDelegation(record);
  }

  function scheduleDelegation(record) {
    clearTimeout(record.timer);
    if (delegationDelayMs === 0) settleDelegation(record);
    else { record.timer = setTimeout(() => settleDelegation(record), delegationDelayMs); record.timer.unref?.(); }
  }

  function isTerminalDelegation(record) {
    return ["complete", "cancelled", "denied"].includes(record.state);
  }

  function pruneTerminalDelegations() {
    const terminal = [...state.delegationByRequest.entries()].filter(([, record]) => isTerminalDelegation(record));
    while (terminal.length > MAX_TERMINAL_DELEGATIONS) {
      const [id, record] = terminal.shift();
      state.delegationByRequest.delete(id);
      if (record.kind === "live") {
        const key = record.liveSessionId + "\u0000" + record.delegationId;
        if (state.delegationByLiveId.get(key) === record) state.delegationByLiveId.delete(key);
      }
    }
  }

  function rejectBackloggedDelegation(sessionId, delegationId) {
    const message = "Voice requests are backed up. Wait for Claude Code to catch up, then repeat the request.";
    emitStdout({ type: "error", message });
    broadcast({ type: "delivery", delegationId, liveSessionId: sessionId, state: "denied", message });
    appendContext(message, "commentary");
  }

  function processModelEvent(sessionId, event) {
    const session = state.currentSession;
    if (!session || session.id !== sessionId || session.closed) return { stale: true };
    if (!event || typeof event.type !== "string") return { ignored: true };

    if (event.type === "input_transcript.added" || event.type === "output_transcript.added") {
      if (event.event_id && state.transcriptEvents.has(event.event_id)) return { duplicate: true };
      if (event.event_id) {
        state.transcriptEvents.add(event.event_id);
        if (state.transcriptEvents.size > 1200) state.transcriptEvents.delete(state.transcriptEvents.values().next().value);
      }
      const fragment = state.conversation.add(event, sessionId);
      if (!fragment?.delta) return { ignored: true };
      if (!state.caption || state.caption.final || state.caption.role !== fragment.role) {
        finishCaption();
        state.caption = { role: fragment.role, text: '', utteranceId: randomUUID(), liveSessionId: sessionId, final: false };
        if (fragment.role === 'U') { invalidateSpeech(); emitStdout({ type: 'input', liveSessionId: sessionId }); }
      }
      state.caption.text += fragment.delta;
      emitStdout({ type: 'transcript', ...state.caption, delta: fragment.delta, sequence: fragment.sequence });
      clearTimeout(state.captionTimer);
      state.captionTimer = setTimeout(finishCaption, captionDelayMs);
      state.captionTimer.unref?.();
      if (fragment.role === 'U') for (const record of state.delegationByRequest.values()) if (record.timer) scheduleDelegation(record);
      return { transcript: true };
    }
    if (event.type === 'turn.done') { finishCaption(); return { transcript: true }; }
    if (event.type === "delegation.created") {
      const item = event.item;
      if (!item || item.target !== "client") return { ignored: true };
      const delegationId = cleanIdentifier(item.id, 200);
      if (!delegationId) return { ignored: true };
      const key = sessionId + "\u0000" + delegationId;
      const duplicate = state.delegationByLiveId.get(key);
      if (duplicate) return { duplicate: true };

      const pendingCount = [...state.delegationByRequest.values()].filter((record) => !isTerminalDelegation(record)).length;
      if (pendingCount >= MAX_PENDING_DELEGATIONS) {
        rejectBackloggedDelegation(sessionId, delegationId);
        return { rejected: "backlog" };
      }

      const requestId = randomUUID();
      const record = addDelegation({
        id: requestId,
        text: '',
        liveSessionId: sessionId,
        delegationId,
        deferred: true,
      });
      record.task = taskTextFromDelegation(item);
      scheduleDelegation(record);
      return { delegated: true, id: requestId };
    }
    if (event.type === "error") {
      publishStatus("error", "The voice service reported an error.", sessionId);
      return { error: true };
    }
    if (event.type === "session.closed") {
      session.closed = true;
      clearSessionControls(session);
      if (state.currentSession === session) state.currentSession = undefined;
      publishStatus("idle", "Voice session closed.");
      return { closed: true };
    }
    return { ignored: true };
  }

  function acceptReceipt(event) {
    const id = cleanIdentifier(event.requestId, 200);
    const deliveryState = ["appending", "submitting", "waiting", "accepted", "observed", "complete", "cancelled", "denied"].includes(event.state)
      ? event.state
      : undefined;
    if (!id || !deliveryState) return false;
    const record = state.delegationByRequest.get(id);
    const receipt = {
      requestId: id,
      state: deliveryState,
      mode: event.mode === "steer" || event.mode === "submit" ? event.mode : undefined,
      at: Date.now(),
    };
    const turnId = cleanIdentifier(event.turnId, 120);
    if (turnId) receipt.turnId = turnId;
    if (Number.isInteger(event.step) && event.step >= 0) receipt.step = event.step;
    boundedPush(state.receipts, receipt);
    if (record) {
      if (["accepted", "observed"].includes(deliveryState)) {
        record.accepted = true;
        record.text = "";
        if (!["complete", "cancelled"].includes(record.state)) record.state = deliveryState;
        if (Number.isSafeInteger(event.watermark) && event.watermark > 0) {
          state.lastDelegatedWatermark = Math.max(state.lastDelegatedWatermark, event.watermark);
        }
      } else if (!(record.accepted && ["submitting", "waiting", "denied"].includes(deliveryState))) {
        record.state = deliveryState;
      }
    }
    const deliveryMessage = deliveryState === "denied"
      ? "Claude Code did not accept that request. Say it again with a new request to retry."
      : deliveryState === "cancelled"
        ? "Claude Code stopped before handling that request. Say it again with a new request if you still need it."
        : undefined;
    if (deliveryMessage) {
      receipt.message = deliveryMessage;
      broadcast({ type: "delivery", requestId: id, state: deliveryState, message: deliveryMessage });
      appendContext(deliveryMessage, "commentary");
    }
    pruneTerminalDelegations();
    return true;
  }

  function appendContext(text, channel, requestIds = []) {
    const session = state.currentSession;
    if (!session || session.closed) return false;
    const related = requestIds
      .map((id) => state.delegationByRequest.get(id))
      .find((record) =>
        record && record.accepted &&
        record.kind === "live" &&
        record.liveSessionId === session.id &&
        (channel !== 'speakable' || record.speechGeneration === state.speechGeneration) &&
        record.delegationId,
      );
    for (const chunk of contextChunks(text, 400)) {
      const event = related && channel === "speakable"
        ? {
            type: "delegation.context.append",
            delegation_item_id: related.delegationId,
            channel,
            content: [{ type: "input_text", text: chunk }],
          }
        : {
            type: "session.context.append",
            channel,
            content: [{ type: "input_text", text: chunk }],
          };
      streamEvent(event, channel === 'speakable' ? state.speechGeneration : undefined);
    }
    return true;
  }

  function handleFinal(event, requestIds) {
    const suppliedText = safeStatusText(event.text);
    const spokenText = spokenSummary(event.text);
    let reason = ["answer", "aborted", "refusal", "error"].includes(event.reason)
      ? event.reason
      : event.isAborted === true
        ? "aborted"
        : "answer";
    const isAborted = event.isAborted === true || reason === "aborted";
    if (isAborted) reason = "aborted";

    const prefix = isAborted ? "The task was stopped." : reason === "error" ? "Claude Code reported an error." : reason === "refusal" ? "Claude Code declined the task." : "";
    const fallback = reason === "error" ? "Claude Code reported an error while handling the task." : prefix;
    const withPrefix = (text) => (text ? (prefix ? prefix + " " + text : text) : fallback);
    const finalText = withPrefix(suppliedText);
    if (!finalText) return false;

    state.latestFinal = finalText.slice(0, MAX_FINAL_REFERENCE);
    state.latestFinalMeta = {
      text: state.latestFinal,
      reason,
      isAborted,
      at: Date.now(),
    };
    for (const id of requestIds) {
      const record = state.delegationByRequest.get(id);
      if (record) record.finalSeen = true;
    }
    const currentRequest = requestIds.some(id => {
      const record = state.delegationByRequest.get(id);
      return record?.accepted && record.liveSessionId === state.currentSession?.id && record.speechGeneration === state.speechGeneration;
    });
    // Only the latest spoken request's result reaches GPT-Live, and only its
    // first paragraph: Claude leads with a spoken summary, details follow.
    if (event.speak === true && currentRequest) appendContext(withPrefix(spokenText), 'speakable', requestIds);
    pruneTerminalDelegations();
    return true;
  }

  function recordAgentEvent(event) {
    const kind = cleanIdentifier(event.kind, 40) || "unknown";
    const turnId = cleanIdentifier(event.turnId, 120);
    const requestIds = Array.isArray(event.requestIds)
      ? event.requestIds.map((id) => cleanIdentifier(id, 200)).filter(Boolean).slice(0, 20)
      : [];
    const summary = { kind, at: Date.now() };
    if (turnId) summary.turnId = turnId;
    if (event.status && ["started", "completed", "error"].includes(event.status)) summary.status = event.status;
    if (kind === "tool") summary.tool = normalizeSafeTool(event.tool);
    if (kind === "final") {
      if (["answer", "aborted", "refusal", "error"].includes(event.reason)) summary.reason = event.reason;
      summary.isAborted = event.isAborted === true;
      summary.text = safeStatusText(event.text).slice(0, 320);
    }
    boundedPush(state.agentEvents, summary);

    if (kind === "delivery") return acceptReceipt(event);
    if (kind === 'context') {
      if (Number.isSafeInteger(event.watermark)) state.lastDelegatedWatermark = Math.max(state.lastDelegatedWatermark, event.watermark);
      return true;
    }
    if (kind === 'input' && event.origin === 'typed') {
      finishCaption(); invalidateSpeech();
      return true;
    }

    if (kind === "final") {
      return handleFinal(event, requestIds);
    }

    if (kind === "text" && event.final === true) {
      return handleFinal(event, requestIds);
    }

    // GPT-Live gets no progress (tool activity, interim text, typed input):
    // it acts only on results, and every extra line is something it may speak.
    return true;
  }

  async function serveStatic(pathname, response) {
    const entry = STATIC_FILES.get(pathname);
    if (!entry) return false;
    const [name, contentType] = entry;
    let body;
    try {
      body = await readFile(new URL(name, MAIN_PAGE));
    } catch {
      sendJson(response, 500, { error: "Voice page is unavailable." });
      return true;
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "microphone=(self)",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
        "media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    response.end(body);
    return true;
  }

  async function handle(request, response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (!checkHostAndOrigin(request)) {
      sendJson(response, 403, { error: "Loopback requests only." });
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url, "http://127.0.0.1").pathname;
    } catch {
      sendJson(response, 400, { error: "Invalid request path." });
      return;
    }

    if (request.method === "GET" && await serveStatic(pathname, response)) return;
    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        phase: state.phase,
        live: !!state.currentSession && !state.currentSession.closed,
      });
      return;
    }

    if (!authorized(request)) {
      sendJson(response, 401, { error: "Unauthorized." });
      return;
    }

    if (request.method === "GET" && pathname === "/state") {
      sendJson(response, 200, stateSnapshot());
      return;
    }

    if (request.method === "GET" && pathname === "/stream") {
      if (state.streamClients.size >= 5) {
        sendJson(response, 429, { error: "Too many local clients." });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write("retry: 2000\n\n");
      state.streamClients.add(response);
      response.write("data: " + JSON.stringify({
        type: "status",
        phase: state.phase,
        message: state.message,
        liveSessionId: state.currentSession?.id,
      }) + "\n\n");
      if (state.pendingConnect) {
        response.write("data: " + JSON.stringify(state.pendingConnect) + "\n\n");
      }
      if (state.currentSession?.micReady && state.currentSession.muteControl) {
        response.write("data: " + JSON.stringify(state.currentSession.muteControl) + "\n\n");
      }
      request.on("close", () => state.streamClients.delete(response));
      response.on("close", () => state.streamClients.delete(response));
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      sendJson(response, 415, { error: "Expected application/json." });
      return;
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      const status = error?.status === 413 ? 413 : 400;
      sendJson(response, status, { error: status === 413 ? "Request body is too large." : "Invalid JSON request." });
      return;
    }

    if (pathname === "/control") {
      if (!["connect", "toggle-mute"].includes(body.action)) {
        sendJson(response, 400, { error: "Expected connect or toggle-mute." });
        return;
      }
      if (state.stopping) {
        sendJson(response, 503, { error: "Voice helper is stopping." });
        return;
      }
      if (body.action === "connect") {
        if (state.currentSession && !state.currentSession.closed) {
          sendJson(response, 200, { ok: true, alreadyActive: true, phase: state.phase });
          return;
        }
        if (!state.pendingConnect) {
          state.pendingConnect = makeControl("connect");
          publishStatus("connecting", "Starting background voice host.");
          broadcast(state.pendingConnect);
        }
        sendJson(response, 202, {
          ok: true, pending: true, controlId: state.pendingConnect.controlId, phase: state.phase,
        });
        return;
      }
      const session = state.currentSession;
      if (!session || session.closed || !session.remoteOpen || !session.micReady) {
        sendJson(response, 409, { error: "Voice microphone is not ready." });
        return;
      }
      if (body.sessionId !== undefined && body.sessionId !== session.id) {
        sendJson(response, 409, { error: "This voice session has ended." });
        return;
      }
      session.desiredMuted = !session.desiredMuted;
      session.muteControl = makeControl("set-mute", {
        liveSessionId: session.id,
        muted: session.desiredMuted,
      });
      broadcast(session.muteControl);
      sendJson(response, 202, {
        ok: true, muted: session.desiredMuted,
        controlId: session.muteControl.controlId, phase: state.phase,
      });
      return;
    }

    if (pathname === "/live/call") {
      if (typeof body.sdp !== "string" || !body.sdp.startsWith("v=0") || body.sdp.length > 300_000) {
        sendJson(response, 400, { error: "A valid WebRTC SDP offer is required." });
        return;
      }
      if (state.stopping) {
        sendJson(response, 503, { error: "Voice helper is stopping." });
        return;
      }
      if (state.activeCallController || (state.currentSession && !state.currentSession.closed)) {
        sendJson(response, 409, { error: "A voice session is already active." });
        return;
      }
      const connectControlId = cleanIdentifier(body.controlId, 200);
      if (body.controlId !== undefined && (!connectControlId || state.pendingConnect?.controlId !== connectControlId)) {
        sendJson(response, 409, { error: "This voice connection request has ended." });
        return;
      }
      const voice = typeof body.voice === "string" && /^[a-z0-9_-]{1,32}$/i.test(body.voice)
        ? body.voice
        : "cove";
      const callId = cleanIdentifier(body.callId, 200) || randomUUID();
      if (state.cancelledCallIds.has(callId)) {
        sendJson(response, 409, { error: "Voice connection was cancelled." });
        return;
      }
      const session = {
        id: randomUUID(), callId, connectControlId,
        remoteOpen: false, micReady: false, muted: false, desiredMuted: false, closed: false,
      };
      state.currentSession = session;
      state.pendingConnect = undefined;
      const controller = new AbortController();
      state.activeCallController = controller;
      state.activeCallCallId = callId;
      const callTimeout = setTimeout(() => controller.abort("timeout"), 30_000);
      callTimeout.unref?.();
      publishStatus("connecting", "Connecting to voice service.", session.id);
      try {
        const call = await callFactory({
          sdp: body.sdp,
          voice,
          initialItems: [...initialItems, ...makeInitialItems(state.conversation, state.latestFinal)],
          signal: controller.signal,
        });
        if (state.stopping || session.closed || state.currentSession !== session) {
          sendJson(response, 409, { error: "Voice connection was cancelled." });
          return;
        }
        sendJson(response, 200, { sdp: call.answer, sessionId: session.id });
      } catch (error) {
        if (state.currentSession === session) state.currentSession = undefined;
        const cancelled = state.stopping || session.closed || controller.signal.reason === "cancelled" || controller.signal.reason === "shutdown";
        if (cancelled) {
          sendJson(response, 409, { error: "Voice connection was cancelled." });
        } else {
          publishStatus("error", safeError(error));
          sendJson(response, 502, { error: safeError(error) });
        }
      } finally {
        clearTimeout(callTimeout);
        if (state.activeCallController === controller) state.activeCallController = undefined;
        if (state.activeCallCallId === callId) state.activeCallCallId = undefined;
      }
      return;
    }

    if (pathname === "/live/failure") {
      const message = FRONTEND_FAILURES.get(body.code);
      const callId = cleanIdentifier(body.callId, 200);
      const sessionId = cleanIdentifier(body.sessionId, 200);
      const controlId = cleanIdentifier(body.controlId, 200);
      if (!message || !callId || (body.sessionId !== undefined && !sessionId) || (body.controlId !== undefined && !controlId)) {
        sendJson(response, 400, { error: "A callId and supported failure code are required." });
        return;
      }
      if (state.stopping) {
        sendJson(response, 503, { error: "Voice helper is stopping." });
        return;
      }
      const session = state.currentSession;
      const matchesSession = session && !session.closed && session.callId === callId &&
        (!sessionId || session.id === sessionId) && (!controlId || session.connectControlId === controlId);
      const matchesPendingControl = !session && !sessionId && controlId &&
        state.pendingConnect?.controlId === controlId && !state.cancelledCallIds.has(callId);
      if (!matchesSession && !matchesPendingControl) {
        sendJson(response, 409, { error: "This voice connection request has ended." });
        return;
      }
      markCallCancelled(callId);
      if (matchesSession) {
        session.closed = true;
        clearSessionControls(session);
        state.currentSession = undefined;
        state.pendingLiveEvents = state.pendingLiveEvents.filter((item) => item.sessionId !== session.id);
        if (state.activeCallCallId === callId) state.activeCallController?.abort("cancelled");
      } else {
        state.pendingConnect = undefined;
      }
      publishStatus("error", message, matchesSession ? session.id : undefined);
      sendJson(response, 202, { ok: true, code: body.code });
      return;
    }

    if (pathname === "/live/cancel") {
      const callId = cleanIdentifier(body.callId, 200);
      const sessionId = cleanIdentifier(body.sessionId, 200);
      if (!callId && !sessionId) {
        sendJson(response, 400, { error: "A callId or sessionId is required." });
        return;
      }
      let cancelled = !!callId;
      markCallCancelled(callId);
      const session = state.currentSession;
      const matchingSession = session && (
        (sessionId && session.id === sessionId) || (callId && session.callId === callId)
      );
      if (matchingSession) {
        session.closed = true;
        clearSessionControls(session);
        if (state.currentSession === session) state.currentSession = undefined;
        state.pendingLiveEvents = state.pendingLiveEvents.filter((item) => item.sessionId !== session.id);
        if (state.activeCallCallId === session.callId) state.activeCallController?.abort("cancelled");
        cancelled = true;
      } else if (callId && state.activeCallCallId === callId && state.activeCallController) {
        state.activeCallController.abort("cancelled");
        cancelled = true;
      }
      if (cancelled && !state.stopping && !state.currentSession && state.phase !== "error") publishStatus("idle", "Voice disconnected.");
      sendJson(response, 200, { ok: true, cancelled });
      return;
    }

    if (pathname === "/live/event") {
      const sessionId = cleanIdentifier(body.sessionId, 200);
      const event = body.event;
      if (!sessionId || !event || typeof event.type !== "string") {
        sendJson(response, 400, { error: "A sessionId and event are required." });
        return;
      }
      const session = state.currentSession;
      if (!session || session.id !== sessionId || session.closed) {
        sendJson(response, 409, { error: "This voice session has ended." });
        return;
      }

      if (event.type === "bridge.datachannel.open") {
        session.remoteOpen = true;
        publishStatus("connecting", "Voice channel open. Starting microphone.", session.id);
        flushPendingLiveEvents(session.id);
      } else if (event.type === "bridge.mic.ready") {
        if (!session.remoteOpen) {
          sendJson(response, 409, { error: "Voice channel is not ready." });
          return;
        }
        if (!session.micReady) {
          session.micReady = true;
          session.muted = false;
          session.desiredMuted = false;
        }
        publishStatus(session.muted ? "muted" : "listening", session.muted ? "Microphone muted." : "Listening.", session.id);
      } else if (event.type === "bridge.mic.muted" || event.type === "bridge.mic.unmuted") {
        if (!session.micReady) {
          sendJson(response, 409, { error: "Voice microphone is not ready." });
          return;
        }
        const muted = event.type === "bridge.mic.muted";
        if (session.muteControl) {
          if (event.controlId !== session.muteControl.controlId || muted !== session.desiredMuted) {
            sendJson(response, 409, { error: "This microphone control has been superseded." });
            return;
          }
        } else if (event.controlId !== undefined) {
          sendJson(response, 409, { error: "This microphone control has ended." });
          return;
        } else {
          session.desiredMuted = muted;
        }
        session.muted = muted;
        publishStatus(muted ? "muted" : "listening", muted ? "Microphone muted." : "Listening.", session.id);
      } else if (event.type === "bridge.closed") {
        finishCaption();
        session.closed = true;
        clearSessionControls(session);
        if (state.currentSession === session) state.currentSession = undefined;
        state.pendingLiveEvents = state.pendingLiveEvents.filter((item) => item.sessionId !== session.id);
        publishStatus("idle", "Voice disconnected.");
      } else if (event.type === "bridge.error") {
        finishCaption();
        session.closed = true;
        clearSessionControls(session);
        if (state.currentSession === session) state.currentSession = undefined;
        publishStatus("error", "Voice connection failed.");
      } else {
        const result = processModelEvent(sessionId, event);
        if (result.stale) {
          sendJson(response, 409, { error: "This voice session has ended." });
          return;
        }
      }
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === "/delegate") {
      const id = cleanIdentifier(body.id, 200);
      const text = typeof body.text === "string" ? cleanText(body.text).trim().slice(0, MAX_REQUEST_TEXT) : "";
      if (!id || !text) {
        sendJson(response, 400, { error: "An id and nonempty task text are required." });
        return;
      }
      const existing = state.delegationByRequest.get(id);
      if (existing) {
        sendJson(response, 200, { ok: true, duplicate: true, retried: false, state: existing.state, attempts: existing.attempts });
        return;
      }
      const pendingCount = [...state.delegationByRequest.values()].filter((record) => !isTerminalDelegation(record)).length;
      if (pendingCount >= MAX_PENDING_DELEGATIONS) {
        sendJson(response, 429, { error: "Voice requests are backed up. Wait for Claude Code to catch up, then repeat the request." });
        return;
      }
      const liveSessionId = state.currentSession?.id ?? "offline";
      addDelegation({ id, text, liveSessionId, delegationId: id, kind: "external" });
      sendJson(response, 202, { ok: true, id, liveSessionId });
      return;
    }

    if (pathname === "/agent-events") {
      if (!Array.isArray(body.events) || body.events.length > 100) {
        sendJson(response, 400, { error: "events must be an array with at most 100 entries." });
        return;
      }
      let received = 0;
      for (const event of body.events) {
        if (!event || typeof event !== "object" || Array.isArray(event)) continue;
        recordAgentEvent(event);
        received++;
      }
      sendJson(response, 202, { ok: true, received });
      return;
    }

    if (pathname === "/shutdown") {
      finishCaption();
      state.stopping = true;
      state.pendingConnect = undefined;
      state.activeCallController?.abort("shutdown");
      publishStatus("stopping", "Voice helper is stopping.");
      broadcast({ type: "shutdown" });
      sendJson(response, 202, { ok: true });
      setTimeout(() => void close(), 25).unref?.();
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "Voice helper request failed." });
      else response.destroy();
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  let closed = false;
  async function listen() {
    if (server.listening) return server.address();
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    state.port = server.address().port;
    emitStdout({ type: "ready", port: state.port, url: "http://127.0.0.1:" + state.port + "/" });
    return server.address();
  }

  async function close() {
    if (closed) return;
    closed = true;
    state.stopping = true;
    state.pendingConnect = undefined;
    state.activeCallController?.abort("shutdown");
    finishCaption();
    for (const record of state.delegationByRequest.values()) clearTimeout(record.timer);
    for (const response of state.streamClients) {
      try { response.end(); } catch {}
    }
    state.streamClients.clear();
    if (!server.listening) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, state, listen, close, snapshot: stateSnapshot };
}

async function main() {
  const output = (line) => process.stdout.write(line);
  let bridge;
  try {
    bridge = createHelperServer({ stdout: output });
    await bridge.listen();
  } catch (error) {
    output(JSON.stringify({ type: "error", message: safeError(error) }) + "\n");
    process.exitCode = 1;
    return;
  }
  const stop = () => void bridge.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (process.env.UVOICE_PARENT_PIPE === "1") {
    process.stdin.once("end", stop);
    process.stdin.once("error", stop);
    process.stdin.resume();
    process.stdin.unref?.();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
