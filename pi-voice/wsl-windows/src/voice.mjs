import { LiveConnection, VoiceError, safeError } from "./live.mjs";
import { openMedia, hasSpeechEnergy } from "./media.mjs";
import { Conversation, contextChunks } from "./conversation.mjs";

export const VOICE_PROMPT =
  "You are the user's voice interface to Pi, a coding agent. Converse concisely in English. Help refine requests, and delegate work to Pi when the user is ready. Include follow-up corrections and constraints.";

// Long Pi answers must not stop mid-sentence when the spoken budget is capped.
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
    key = /** @type {string | undefined} */ (undefined),
    getKey = async () => key,
    source,
    voice = "marin",
    submit,
    status,
    notify,
    persist,
    fragments = /** @type {import("./conversation.mjs").Fragment[]} */ ([]),
    lastDelegated = 0,
    lastDisplayed = 0,
    latestResult = "",
    connectionFactory = (options) => new LiveConnection(options),
    mediaFactory = openMedia,
    delegateDelay = 1200,
    graceMs = 5000,
  }) {
    Object.assign(this, {
      getKey,
      source,
      voice,
      submit,
      status,
      notify,
      persist,
      connectionFactory,
      mediaFactory,
      delegateDelay,
      graceMs,
      latestResult,
    });
    this.conversation = new Conversation(fragments);
    this.lastDelegated = lastDelegated;
    this.lastDisplayed = Math.max(lastDisplayed, lastDelegated);
    this.phase = "muted";
    this.enabled = false;
    this.generation = 0;
    this.closed = false;
    this.delegations = new Map();
    this.totalSeconds = 0;
    this.announcePending = false;
    this.announcedResult = "";
    this.publish();
  }

  publish() {
    const previewVersion =
      this.conversation.nextSequence + ":" + this.lastDisplayed;
    if (previewVersion !== this.previewVersion) {
      this.previewVersion = previewVersion;
      this.preview = this.conversation.text(
        this.conversation.fragments.filter(
          (f) => f.sequence > this.lastDisplayed,
        ),
      );
    }
    this.status({
      phase: this.phase,
      seconds:
        this.phase === "live"
          ? Math.floor((performance.now() - this.startedAt) / 1000)
          : 0,
      totalSeconds: this.totalSeconds,
      catchingUp: this.media?.rate === 1.5,
      transcript: this.preview,
    });
  }

  toggle() {
    return this.enabled ? this.pause() : this.start();
  }

  async start() {
    if (this.closed || this.enabled || this.stopping) return;
    const generation = ++this.generation;
    this.enabled = true;
    this.phase = "warming";
    this.publish();
    try {
      if (!(await this.getKey())) {
        throw new VoiceError(
          "Add your OpenAI API key with /login → Sign in with an API key → Voice Agent, then use /m.",
        );
      }
      if (!this.enabled || this.closed || generation !== this.generation)
        return;
      const media = this.mediaFactory({
        source: this.source,
        onWake: () => {
          if (generation === this.generation) this.wake();
        },
        onSpeech: (speaking) => {
          if (!this.enabled || generation !== this.generation) return;
          this.speaking = speaking;
          if (speaking) this.lastUserActivity = performance.now();
        },
        onInput: (pcm) => {
          if (this.phase !== "live" || generation !== this.generation) return;
          if (this.connection.socket?.bufferedAmount > 48000 * 3) {
            void this.fail(new Error("audio network backlog"));
            return;
          }
          this.connection.send({
            type: "session.input_audio.append",
            audio: pcm.toString("base64"),
          });
        },
        onError: (error) => {
          if (generation === this.generation) void this.fail(error);
        },
      });
      this.media = media;
      await media.ready;
      if (!this.enabled || this.closed || generation !== this.generation) {
        await media.close();
        return;
      }
      this.phase = "armed";
      this.publish();
      if (this.pendingWake) this.wake();
    } catch (error) {
      if (this.enabled && generation === this.generation)
        await this.fail(error);
    }
  }

  wake() {
    if (!this.enabled || this.closed) return;
    if (this.phase === "warming" || this.phase === "closing") {
      this.pendingWake = true;
      return;
    }
    if (this.phase !== "armed") return;
    this.pendingWake = false;
    this.phase = "connecting";
    this.publish();
    this.opening = this.connect(this.generation);
  }

  async connect(generation) {
    try {
      const key = await this.getKey();
      if (
        !this.enabled ||
        this.closed ||
        generation !== this.generation ||
        this.phase !== "connecting"
      )
        return;
      if (!key) {
        throw new VoiceError(
          "Voice Agent is not logged in. Add your OpenAI API key with /login, then use /m.",
        );
      }
      const connection = this.connectionFactory({ key });
      this.connection = connection;
      connection.on("event", (event) => {
        if (this.connection === connection) this.handleEvent(event, connection);
      });
      connection.on("error", (error) => {
        if (this.connection === connection && this.phase === "live")
          void this.fail(error);
      });
      connection.on("disconnect", () => {
        if (this.connection === connection && this.phase === "live")
          void this.fail(new Error("disconnect"));
      });
      await connection.start({
        model: "gpt-live-1",
        instructions: VOICE_PROMPT,
        audio: {
          format: { type: "audio/pcm", rate: 24000 },
          output: { voice: this.voice },
        },
        delegation: { type: "client" },
        input: this.conversation.history(this.latestResult),
        store: false,
      });
      if (
        !this.enabled ||
        this.connection !== connection ||
        this.phase !== "connecting"
      )
        return;
      this.phase = "live";
      this.startedAt = performance.now();
      this.lastAssistantActivity = this.startedAt;
      this.lastTranscriptActivity = this.startedAt;
      this.media.connect();
      if (this.announcePending) {
        // Reopened to voice a Pi result: commentary is said aloud by the model.
        this.announcePending = false;
        for (const chunk of contextChunks(speakableExcerpt(this.latestResult)))
          this.connection.append("commentary", chunk);
      }
      this.ticker = setInterval(() => {
        this.checkIdle();
        this.publish();
      }, 250);
      this.ticker.unref?.();
      this.publish();
    } catch (error) {
      if (
        this.enabled &&
        generation === this.generation &&
        this.phase !== "closing"
      )
        await this.fail(error);
    }
  }

  checkIdle(now = performance.now()) {
    if (
      this.phase !== "live" ||
      this.speaking ||
      this.media.rate === 1.5 ||
      this.media.backlogMs > 500
    )
      return;
    if ([...this.delegations.values()].some((item) => item.timer)) return;
    const lastActivity = Math.max(
      this.lastUserActivity ?? this.startedAt,
      this.lastAssistantActivity,
      this.lastTranscriptActivity,
      this.media.playbackUntil ?? 0,
      this.lastDispatchAt ?? 0,
    );
    // Fixed grace window: user speech, assistant audio, captions, audible playback,
    // or a fresh Pi dispatch each reset it. After graceMs of none of those the paid
    // session closes; Pi keeps working and later results announce on a short reopen.
    if (now - lastActivity >= this.graceMs) void this.closeLive();
  }

  handleEvent(event, connection) {
    const fragment = this.conversation.add(event, connection.sessionId);
    if (fragment) {
      this.persist("fragment", fragment);
      this.lastTranscriptActivity = performance.now();
      if (fragment.role === "U") {
        for (const item of this.delegations.values())
          if (!item.sent) this.schedule(item);
      }
      this.publish();
    }
    if (event.type === "session.output_audio.delta" && this.phase === "live") {
      const pcm = Buffer.from(event.delta, "base64");
      if (hasSpeechEnergy(pcm)) this.lastAssistantActivity = performance.now();
      this.media?.play(pcm);
    } else if (
      event.type === "session.delegation.created" &&
      event.delegation?.target === "client"
    ) {
      const id = event.delegation.id;
      if (typeof id !== "string" || this.delegations.has(id) || this.closed)
        return;
      const item = { id, sent: false };
      this.delegations.set(id, item);
      this.schedule(item);
    }
  }

  schedule(item) {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      item.timer = undefined;
      // Include spoken corrections still queued locally, not just arrived captions.
      if (
        this.speaking ||
        (this.phase === "live" &&
          (this.media?.rate === 1.5 || this.media?.backlogMs > 500))
      )
        this.schedule(item);
      else {
        try {
          this.dispatch(item);
        } catch (error) {
          item.failed = true;
          void this.fail(
            new VoiceError(
              "Voice could not submit to Pi. The transcript is preserved.",
            ),
          );
        }
      }
    }, this.delegateDelay);
  }

  dispatch(item) {
    if (item.sent || item.failed || this.closed) return;
    const candidates = this.conversation.fragments.filter(
      (f) => f.sequence > this.lastDelegated,
    );
    if (!candidates.some((f) => f.role === "U" && f.delta.trim())) return;
    const text = this.conversation.text(candidates);
    // Queue into Pi before advancing the durable watermark.
    this.submit(text);
    item.sent = true;
    const watermark = candidates.at(-1).sequence;
    this.lastDelegated = this.lastDisplayed = watermark;
    this.persist("delegation", { id: item.id, lastDelegated: watermark, text });
    this.lastDispatchAt = performance.now();
    this.publish();
    this.notify("Voice request sent to Pi.", "info");
  }

  flushDisplay() {
    const fragments = this.conversation.fragments.filter(
      (f) => f.sequence > this.lastDisplayed,
    );
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
    if (this.phase === "live") {
      // commentary is the Live-API channel whose content the model says aloud;
      // no instruction text is needed.
      for (const chunk of contextChunks(speakableExcerpt(this.latestResult))) {
        this.connection.append("commentary", chunk);
      }
      this.lastAssistantActivity = performance.now();
      this.lastTranscriptActivity = performance.now();
    } else if (
      this.enabled &&
      (this.phase === "armed" || this.phase === "closing")
    ) {
      // Pi finished after the session closed: reopen briefly; the seeded
      // history already carries the result, so the assistant speaks it.
      this.announcePending = true;
      if (this.phase === "armed") this.wake();
    } else if (this.phase === "connecting") {
      this.announcePending = true;
    }
  }

  closeLive() {
    if (this.closingLive) return this.closingLive;
    const connection = this.connection;
    if (!connection) return Promise.resolve();
    this.phase = "closing";
    clearInterval(this.ticker);
    if (this.enabled) this.media?.sleep();
    this.publish();
    this.closingLive = (async () => {
      const usage = await connection.close();
      for (const item of this.delegations.values()) {
        clearTimeout(item.timer);
        item.timer = undefined;
        try {
          this.dispatch(item);
        } catch {
          item.failed = true;
          this.notify(
            "Voice could not submit to Pi. The transcript is preserved.",
            "error",
          );
        }
      }
      this.delegations.clear();
      this.flushDisplay();
      if (usage?.finalized) this.totalSeconds += usage.seconds ?? 0;
      this.persist("usage", {
        seconds: usage?.seconds ?? 0,
        finalized: usage?.finalized ?? false,
      });
      if (!usage?.finalized)
        this.notify(
          "Voice disconnected; final billed duration was not confirmed.",
          "warning",
        );
      this.connection = undefined;
    })().finally(() => {
      this.closingLive = undefined;
      if (this.enabled && !this.closed) {
        this.phase = "armed";
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
    this.pendingWake = false;
    this.announcePending = false;
    this.speaking = false;
    const media = this.media;
    this.media = undefined;
    // Invoke close immediately: /m disables capture even during network startup.
    const mediaClosed = media?.close();
    this.stopping = (async () => {
      await Promise.all([mediaClosed, this.closeLive()]);
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
