import { VoiceError, safeError } from "./errors.mjs";
import { createLiveCall } from "./call.mjs";
import { getCodexAuth } from "./auth.mjs";
import { openMedia } from "./media.mjs";
import { Conversation, contextChunks } from "./conversation.mjs";

export const VOICE_PROMPT =
  "You are the voice interface to Pi, a coding agent in the terminal. When the user says \"you\", " +
  "it may mean you (the voice interface) or Pi (the agent): route by context — work requests mean " +
  "Pi, conversation means you.\n" +
  "Handle conversation and request-refining yourself. Anything that needs this machine — files, " +
  "commands, project answers — delegate to Pi; when unsure, delegate, since you cannot see the " +
  "files or system.\n" +
  "Reply briefly, carry the user's corrections and constraints, and after delegating wait " +
  "silently: the client returns Pi's answer and you speak it.";

// The realtime context append endpoint is limited to 500 tokens per append;
// contextChunks keeps each append far below that, so this cap only bounds how
// much of a long Pi answer is spoken at all (the terminal holds the full text).
function speakableExcerpt(text, maxChars = 2200) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  let boundary = 0;
  for (const ch of [".", "!", "?", "\n", "。", "।"]) {
    const i = cut.lastIndexOf(ch);
    if (i + 1 > boundary) boundary = i + 1;
  }
  // Keep at least 40% of the cap; otherwise a hard cut beats a stub.
  return (boundary >= maxChars * 0.4 ? cut.slice(0, boundary) : cut).trimEnd();
}

export class VoiceSession {
  constructor({
    getAuth = getCodexAuth,
    voice = "cove",
    mediaOptions = {},
    submit,
    status,
    notify,
    persist,
    fragments = [],
    lastDelegated = 0,
    lastDisplayed = 0,
    latestResult = "",
    callFactory = createLiveCall,
    mediaFactory = openMedia,
    delegateDelay = 1200,
    graceMs = 10000,
  }) {
    Object.assign(this, {
      getAuth,
      voice,
      mediaOptions,
      submit,
      status,
      notify,
      persist,
      callFactory,
      mediaFactory,
      delegateDelay,
      graceMs,
      latestResult,
      totalSeconds: 0,
      sessionSeconds: 0,
    });
    this.conversation = new Conversation(fragments);
    this.lastDelegated = lastDelegated;
    this.lastDisplayed = Math.max(lastDisplayed, lastDelegated);
    this.phase = "muted";
    this.enabled = false;
    this.generation = 0;
    this.closed = false;
    this.mediaReady = false;
    this.catchingUp = false;
    this.delegations = new Map();
    this.announcePending = false;
    this.announcedResult = "";
    this.speaking = false;
    this.muted = false;
    this.publish();
  }

  publish() {
    const previewVersion = this.conversation.nextSequence + ":" + this.lastDisplayed;
    if (previewVersion !== this.previewVersion) {
      this.previewVersion = previewVersion;
      this.preview = this.conversation.text(
        this.conversation.fragments.filter((f) => f.sequence > this.lastDisplayed),
      );
    }
    this.status({
      phase: this.phase,
      seconds: this.phase === "live" ? Math.floor((performance.now() - this.startedAt) / 1000) : 0,
      totalSeconds: this.totalSeconds + (this.phase === "live" ? this.sessionSeconds : 0),
      catchingUp: this.phase === "live" && this.catchingUp,
      transcript: this.preview,
      level: this.level,
    });
  }

  /**
   * /m: first press starts local listening, later presses mute or unmute only
   * the microphone. The media host stays up while muted so Pi's results can
   * still be spoken, and no metered session is open while muted.
   */
  async toggleMute() {
    if (!this.enabled) {
      await this.start();
      return;
    }
    if (this.muted) {
      this.muted = false;
      this.media?.mute(false);
      if (this.phase === "muted") {
        this.phase = this.mediaReady ? "armed" : "warming";
        this.publish();
        if (this.phase === "armed" && this.pendingWake) this.wake();
      }
      this.notify("Microphone on; listening.", "info");
      return;
    }
    this.muted = true;
    this.media?.mute(true);
    this.pendingWake = false;
    this.speaking = false;
    this.notify("Microphone muted; Pi's results will still be spoken.", "info");
    if (this.phase === "live" || this.phase === "connecting" || this.phase === "closing") {
      await this.closeLive();
    } else {
      this.phase = "muted";
      this.publish();
    }
  }

  async start() {
    if (this.closed || this.enabled || this.stopping) return;
    const generation = ++this.generation;
    this.enabled = true;
    this.muted = false;
    this.mediaReady = false;
    this.phase = "warming";
    this.publish();
    // Capture starts about a second in (browser launch + microphone). Tell the
    // user clearly instead of silently losing whatever they said meanwhile.
    const warmingNotice = setTimeout(() => {
      if (this.enabled && this.phase === "warming")
        this.notify("Voice is warming up — speak once the status shows listening.", "info");
    }, 700);
    try {
      const media = this.mediaFactory({
        ...this.mediaOptions,
        onSpeech: (speaking) => {
          if (!this.enabled || generation !== this.generation) return;
          if (this.muted) return;
          this.speaking = speaking;
          if (speaking) {
            this.lastUserActivity = performance.now();
            this.wake();
          }
        },
        onAudio: (active) => {
          if (!this.enabled || generation !== this.generation) return;
          if (active) this.lastAssistantActivity = performance.now();
        },
        onLevel: (level) => {
          if (!this.enabled || generation !== this.generation) return;
          this.level = { ...level, at: performance.now() };
          const now = performance.now();
          if (!this.levelPublishedAt || now - this.levelPublishedAt > 250) {
            this.levelPublishedAt = now;
            this.publish();
          }
        },
        onEvent: (event) => {
          if (!this.enabled || generation !== this.generation) return;
          this.handleEvent(event);
        },
        onTelemetry: (event) => {
          if (!this.enabled || generation !== this.generation) return;
          if (event?.type === "catchup") {
            this.catchingUp = false;
            this.publish();
          }
        },
        onNotice: (message) => {
          if (!this.enabled || generation !== this.generation) return;
          this.notify(message, "warning");
        },
        onError: (error) => {
          if (generation === this.generation) void this.fail(error);
        },
      });
      this.media = media;
      await media.ready;
      clearTimeout(warmingNotice);
      if (!this.enabled || this.closed || generation !== this.generation) {
        await media.close();
        return;
      }
      this.mediaReady = true;
      this.phase = this.muted ? "muted" : "armed";
      this.publish();
      if (!this.muted && this.pendingWake) this.wake();
    } catch (error) {
      clearTimeout(warmingNotice);
      if (this.enabled && generation === this.generation) await this.fail(error);
    }
  }

  wake() {
    if (!this.enabled || this.closed) return;
    if (this.phase === "warming" || this.phase === "closing") {
      this.pendingWake = true;
      return;
    }
    if (this.phase === "muted") {
      // A muted voice only reopens to speak a finished Pi result.
      if (!this.announcePending) return;
    } else if (this.phase !== "armed") return;
    this.pendingWake = false;
    this.catchingUp = true;
    this.phase = "connecting";
    this.publish();
    void this.connect(this.generation);
  }

  async connect(generation) {
    try {
      const auth = await this.getAuth();
      if (!this.enabled || this.closed || generation !== this.generation || this.phase !== "connecting") return;
      const offer = await this.media.createOffer();
      if (!this.enabled || this.closed || generation !== this.generation || this.phase !== "connecting") return;
      const call = await this.callFactory({
        sdp: offer,
        instructions: VOICE_PROMPT,
        voice: this.voice,
        initialItems: this.conversation.history(this.latestResult),
        auth,
      });
      if (!this.enabled || this.closed || generation !== this.generation || this.phase !== "connecting") return;
      this.media.answer(call.answer);
      await this.media.waitConnected();
      if (!this.enabled || this.closed || generation !== this.generation || this.phase !== "connecting") return;
      this.phase = "live";
      this.startedAt = performance.now();
      this.sessionSeconds = 0;
      this.lastAssistantActivity = this.startedAt;
      this.lastTranscriptActivity = this.startedAt;
      if (this.announcePending) {
        this.announcePending = false;
        this.speak(this.latestResult, { announce: true });
      }
      this.ticker = setInterval(() => {
        this.checkIdle();
        this.publish();
      }, 250);
      this.ticker.unref?.();
      this.publish();
    } catch (error) {
      if (this.enabled && generation === this.generation && this.phase !== "closing") {
        await this.fail(error);
      }
    }
  }

  checkIdle(now = performance.now()) {
    if (this.phase !== "live" || this.speaking || this.media?.assistantActive) return;
    if ([...this.delegations.values()].some((item) => item.timer)) return;
    const lastActivity = Math.max(
      this.lastUserActivity ?? this.startedAt,
      this.lastAssistantActivity ?? 0,
      this.lastTranscriptActivity ?? 0,
      this.lastDispatchAt ?? 0,
    );
    // After graceMs without speech, assistant audio, transcripts, or a fresh Pi
    // dispatch, the metered session closes. Pi keeps working; its later result
    // reopens a short session to be spoken.
    if (now - lastActivity >= this.graceMs) void this.closeLive();
  }

  handleEvent(event) {
    if (!event || typeof event.type !== "string") return;
    if (event.type === "session.usage.updated") {
      const ms = event.usage?.audio_duration_ms;
      if (typeof ms === "number") this.sessionSeconds = ms / 1000;
      return;
    }
    if (event.type === "error") {
      const message = event.error?.message || event.message || "Voice connection error.";
      void this.fail(new VoiceError(String(message)));
      return;
    }
    if (event.type === "session.closed") {
      if (this.phase === "live") void this.closeLive();
      return;
    }
    const fragment = this.conversation.add(event, this.sessionId);
    if (fragment) {
      this.persist("fragment", fragment);
      this.lastTranscriptActivity = performance.now();
      if (fragment.role === "U") {
        for (const item of this.delegations.values()) if (!item.sent) this.schedule(item);
      }
      this.publish();
    }
    if (event.type === "session.started" && event.session?.id) {
      this.sessionId = event.session.id;
    } else if (event.type === "delegation.created" && event.item?.target === "client") {
      const id = event.item.id;
      if (typeof id !== "string" || this.delegations.has(id) || this.closed) return;
      const item = { id, sessionId: this.sessionId, sent: false, fulfilled: false };
      this.delegations.set(id, item);
      this.schedule(item);
    }
  }

  schedule(item) {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      item.timer = undefined;
      // Include spoken corrections still being transcribed, not just arrived captions.
      if (this.speaking || this.phase === "connecting") this.schedule(item);
      else {
        try {
          this.dispatch(item);
        } catch {
          item.failed = true;
          void this.fail(new VoiceError("Voice could not submit to Pi. The transcript is preserved."));
        }
      }
    }, this.delegateDelay);
  }

  dispatch(item) {
    if (item.sent || item.failed || this.closed) return;
    const candidates = this.conversation.fragments.filter((f) => f.sequence > this.lastDelegated);
    if (!candidates.some((f) => f.role === "U" && f.delta.trim())) return;
    const text = this.conversation.text(candidates);
    // Queue into Pi before advancing the durable watermark.
    this.submit(text);
    item.sent = true;
    this.lastDispatch = item;
    const watermark = candidates.at(-1).sequence;
    this.lastDelegated = this.lastDisplayed = watermark;
    this.persist("delegation", { id: item.id, lastDelegated: watermark, text });
    this.lastDispatchAt = performance.now();
    this.publish();
    this.notify("Voice request sent to Pi.", "info");
  }

  flushDisplay() {
    const fragments = this.conversation.fragments.filter((f) => f.sequence > this.lastDisplayed);
    if (!fragments.length) return;
    this.lastDisplayed = fragments.at(-1).sequence;
    this.persist("conversation", {
      text: this.conversation.text(fragments),
      lastDisplayed: this.lastDisplayed,
    });
  }

  setResult(text) {
    this.latestResult = text;
    this.persist("result", { text });
    if (!text.trim() || this.announcedResult === text) return;
    this.announcedResult = text;
    this.speak(text);
  }

  speak(text, { announce = false } = {}) {
    if (!this.media || this.closed) return;
    const chunks = contextChunks(speakableExcerpt(text));
    if (this.phase === "live") {
      const item =
        !announce &&
        this.lastDispatch &&
        !this.lastDispatch.fulfilled &&
        this.lastDispatch.sessionId === this.sessionId
          ? this.lastDispatch
          : undefined;
      if (item) item.fulfilled = true;
      const type = item ? "delegation.context.append" : "session.context.append";
      for (const chunk of chunks) {
        this.media.send({
          type,
          channel: "speakable",
          ...(item ? { delegation_item_id: item.id } : {}),
          content: [{ type: "input_text", text: chunk }],
        });
      }
      this.lastAssistantActivity = performance.now();
      this.lastTranscriptActivity = performance.now();
    } else if (
      this.enabled &&
      (this.phase === "armed" ||
        this.phase === "muted" ||
        this.phase === "closing" ||
        this.phase === "connecting")
    ) {
      // Pi finished after the session closed: reopen briefly and speak the result.
      // While muted this speaks without turning the microphone back on.
      this.announcePending = true;
      if (this.phase === "armed" || this.phase === "muted") this.wake();
    }
  }

  closeLive() {
    if (this.closingLive) return this.closingLive;
    if (!this.media) return Promise.resolve();
    this.phase = "closing";
    clearInterval(this.ticker);
    if (this.enabled) this.media.sleep();
    this.publish();
    this.closingLive = Promise.resolve().then(() => {
      for (const item of this.delegations.values()) {
        clearTimeout(item.timer);
        item.timer = undefined;
        try {
          this.dispatch(item);
        } catch {
          item.failed = true;
          this.notify("Voice could not submit to Pi. The transcript is preserved.", "error");
        }
      }
      this.delegations.clear();
      this.lastDispatch = undefined;
      this.sessionId = undefined;
      this.flushDisplay();
      this.totalSeconds += Math.round(this.sessionSeconds);
      this.sessionSeconds = 0;
      this.catchingUp = false;
      this.persist("usage", { seconds: this.totalSeconds, source: "subscription" });
    }).finally(() => {
      this.closingLive = undefined;
      if (this.enabled && !this.closed) {
        this.phase = this.muted ? "muted" : "armed";
        this.publish();
        if (this.pendingWake || this.announcePending) this.wake();
      }
    });
    return this.closingLive;
  }

  pause() {
    if (this.stopping) return this.stopping;
    ++this.generation;
    this.enabled = false;
    this.muted = false;
    this.mediaReady = false;
    this.catchingUp = false;
    this.pendingWake = false;
    this.announcePending = false;
    this.speaking = false;
    const media = this.media;
    this.media = undefined;
    clearInterval(this.ticker);
    // Close immediately so capture stops even during network startup.
    const mediaClosed = media?.close();
    this.stopping = (async () => {
      await mediaClosed;
      this.flushDisplay();
      this.phase = this.closed ? "closed" : "muted";
      this.publish();
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  async fail(error) {
    if (!this.enabled) return;
    this.notify(safeError(error), "error");
    await this.pause();
  }

  async shutdown() {
    this.closed = true;
    this.phase = "closed";
    for (const item of this.delegations.values()) clearTimeout(item.timer);
    await this.pause();
    this.delegations.clear();
  }
}
