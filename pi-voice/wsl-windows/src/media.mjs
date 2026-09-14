import { spawn } from "node:child_process";
import { openProcessor } from "./processor.mjs";
import { VoiceError } from "./live.mjs";

export function hasSpeechEnergy(pcm) {
  if (pcm.length < 2) return false;
  let energy = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  return energy / Math.floor(pcm.length / 2) > 32768 ** 2 * 10 ** (-45 / 10);
}

/** Native WSLg transport; the worker buffers original audio before connecting. */
export function openMedia({ source, onInput, onWake, onSpeech, onError }) {
  const children = [];
  let closed = false;
  let streaming = false;
  let pendingPull = false;
  let stream = 0;
  let partial = Buffer.alloc(0);
  let timer, captureTimer, playback;
  let playbackCursor = 0;
  const media = {
    backlogMs: 0,
    playbackUntil: 0,
    rate: 1,
    ready: undefined,
    connect() {
      if (closed) return;
      ++stream;
      pendingPull = false;
      streaming = true;
      worker.send({ type: "start" });
      let deadline = performance.now();
      const pull = () => {
        if (!streaming || closed) return;
        if (!pendingPull) {
          pendingPull = true;
          worker.send({ type: "pull", stream });
        }
        deadline = Math.max(deadline + 20, performance.now() + 1);
        timer = setTimeout(pull, Math.max(1, deadline - performance.now()));
      };
      pull();
    },
    sleep() {
      ++stream;
      pendingPull = false;
      streaming = false;
      clearTimeout(timer);
      worker.send({ type: "sleep" });
      this.backlogMs = 0;
      this.rate = 1;
    },
    play(pcm) {
      if (closed || !playback) return;
      if (playback.stdin.writableLength > 48000 * 2) {
        onError(new VoiceError("Voice playback fell behind; restart with /m."));
        return;
      }
      const now = performance.now();
      // Include transport buffering when deciding whether the assistant is quiet.
      playbackCursor = Math.max(now, playbackCursor) + pcm.length / 48;
      if (hasSpeechEnergy(pcm)) this.playbackUntil = playbackCursor + 80;
      playback.stdin.write(pcm);
    },
    close() {
      if (this.closing) return this.closing;
      closed = true;
      streaming = false;
      clearTimeout(timer);
      clearTimeout(captureTimer);
      this.closing = Promise.all([
        worker.close(),
        ...children.map(
          (child) =>
            new Promise((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
              }
              const timeout = setTimeout(() => {
                child.kill("SIGKILL");
                resolve();
              }, 1200);
              child.once("close", () => {
                clearTimeout(timeout);
                resolve();
              });
              child.kill("SIGTERM");
            }),
        ),
      ]);
      return this.closing;
    },
  };
  const worker = openProcessor({
    onActivity(event) {
      if (closed) return;
      onSpeech(event.speech);
      if (event.wake) onWake();
    },
    onAudio(event) {
      if (event.stream !== stream) return;
      pendingPull = false;
      if (!streaming || closed) return;
      media.backlogMs = event.backlog_ms;
      media.rate = event.rate;
      if (event.audio) onInput(Buffer.from(event.audio, "base64"));
    },
    onError,
  });
  function launch(command, args, stdio) {
    const child = spawn(command, args, { stdio });
    children.push(child);
    child.stderr.resume();
    child.on("error", () => {
      if (!closed)
        onError(
          new VoiceError("WSLg audio could not start. Check pulseaudio-utils."),
        );
    });
    child.on("close", () => {
      if (!closed)
        onError(
          new VoiceError("The microphone or speaker connection stopped."),
        );
    });
    return child;
  }
  media.ready = worker.ready.then(() => {
    if (closed) return;
    const format = ["--raw", "--format=s16le", "--rate=24000", "--channels=1"];
    const capture = launch(
      "parec",
      [
        ...format,
        "--latency-msec=60",
        "--device=" + (source || "@DEFAULT_SOURCE@"),
      ],
      ["ignore", "pipe", "pipe"],
    );
    playback = launch(
      "pacat",
      ["--playback", ...format, "--latency-msec=80"],
      ["pipe", "ignore", "pipe"],
    );
    playback.stdin.on("error", () => {
      if (!closed) onError(new VoiceError("Voice playback stopped."));
    });
    captureTimer = setTimeout(
      () =>
        onError(
          new VoiceError(
            "No microphone audio arrived. Check WSLg microphone permission.",
          ),
        ),
      5000,
    );
    capture.stdout.on("data", (chunk) => {
      if (closed) return;
      clearTimeout(captureTimer);
      partial = Buffer.concat([partial, chunk]);
      while (partial.length >= 960) {
        worker.send({
          type: "input",
          audio: partial.subarray(0, 960).toString("base64"),
        });
        partial = partial.subarray(960);
      }
    });
  });
  return media;
}
