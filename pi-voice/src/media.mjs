import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { VoiceError } from "./errors.mjs";

const FRAME_BYTES = 960; // 20 ms of 24 kHz s16le mono, the VAD frame size

/**
 * Media manager: owns the browser media host (microphone, speakers, WebRTC)
 * and the local Silero VAD worker. The page feeds 24 kHz PCM to the worker so
 * speech detection sees exactly the audio the model hears, while the metered
 * session stays closed until speech actually happens. `inputWav` feeds a
 * synthesized request instead of the microphone for the live smoke test.
 */
export function openMedia({
  onSpeech = () => {},
  onEvent = () => {},
  onAudio = () => {},
  onLevel = () => {},
  onNotice = () => {},
  onError = () => {},
  onTelemetry = () => {},
  inputWav,
  browser,
} = {}) {
  const helperPath = fileURLToPath(new URL("../media/chromium-helper.mjs", import.meta.url));
  const pythonPath = fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
  const workerPath = fileURLToPath(new URL("../audio/worker.py", import.meta.url));
  if (!existsSync(pythonPath)) {
    throw new VoiceError("Local audio is not set up. Run bin/setup-audio, then use /m again.");
  }

  const children = [];
  const state = {
    closed: false,
    armed: false,
    connected: false,
    assistantActive: false,
    helperStderr: "",
    pendingOffer: undefined,
    pendingConnected: new Set(),
  };

  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let workerReady = false;
  let readyDone = false;

  function resolveReadyOnce() {
    if (readyDone) return;
    readyDone = true;
    resolveReady();
  }

  const fail = (message) => {
    if (state.closed) return;
    const error = message instanceof VoiceError ? message : new VoiceError(String(message));
    if (!readyDone) {
      rejectReady(error);
    } else onError(error);
  };

  // ---- helper process -------------------------------------------------
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(helper);
  helper.stderr.setEncoding("utf8");
  helper.stderr.on("data", (chunk) => {
    state.helperStderr = (state.helperStderr + chunk).slice(-4000);
  });
  const helperLines = createInterface({ input: helper.stdout });
  helperLines.on("line", (line) => handleHelperLine(line));
  helper.on("error", (error) => fail("Unable to start the media host: " + error.message));
  helper.on("exit", (code, signal) => {
    if (!state.closed)
      fail(
        "The media host exited (code=" + String(code) + ", signal=" + String(signal) + ")" +
          stderrSuffix(),
      );
  });
  helper.stdin.on("error", () => {});

  function stderrSuffix() {
    const tail = state.helperStderr.trim();
    return tail ? ": " + tail : "";
  }

  function send(message) {
    if (state.closed || !helper.stdin.writable) return;
    helper.stdin.write(JSON.stringify(message) + "\n");
  }

  function handleHelperLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    switch (event.type) {
      case "media.state":
        if (event.state === "armed") {
          state.armed = true;
          state.connected = false;
          if (workerReady) resolveReadyOnce();
        }
        break;
      case "media.offer": {
        const pending = state.pendingOffer;
        state.pendingOffer = undefined;
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(event.sdp);
        }
        break;
      }
      case "media.connected":
        state.connected = true;
        for (const entry of state.pendingConnected) {
          clearTimeout(entry.timer);
          entry.resolve();
        }
        state.pendingConnected.clear();
        break;
      case "media.pcm":
        lastPcmAt = performance.now();
        micNotice = false;
        feedWorker(event.audio);
        break;
      case "media.event":
        try {
          onEvent(JSON.parse(event.data));
        } catch {
          // The page relays raw data-channel JSON; ignored when unparseable.
        }
        break;
      case "media.audio":
        state.assistantActive = Boolean(event.active);
        onAudio(state.assistantActive);
        break;
      case "media.catchup":
        onTelemetry({ type: "catchup", outputMs: event.outputMs, consumedMs: event.consumedMs });
        break;
      case "media.buffered":
        onTelemetry({ type: "buffered", ms: event.ms });
        break;
      case "media.overflow":
        onNotice(
          "Speech outlasted the 10 s connection buffer; the earliest audio was dropped. " +
            "The connection was unusually slow.",
        );
        break;
      case "media.error":
        if (event.fatal !== false) fail(event.message + stderrSuffix());
        else onError(new VoiceError(event.message));
        break;
      default:
        break;
    }
  }

  // ---- local VAD worker ----------------------------------------------
  const worker = spawn(pythonPath, ["-u", workerPath], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(worker);
  worker.stderr.resume();
  const workerLines = createInterface({ input: worker.stdout });
  workerLines.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "ready") {
      workerReady = true;
      if (state.armed) resolveReadyOnce();
    } else if (event.type === "activity") {
      onSpeech(Boolean(event.speech));
    } else if (event.type === "level") {
      onLevel({ vad: Number(event.vad), db: Number(event.db) });
    } else if (event.type === "error") {
      fail("Local speech detection failed. Run bin/setup-audio, then use /m again.");
    }
  });
  worker.on("error", (error) => fail("Unable to start local speech detection: " + error.message));
  worker.on("exit", () => {
    if (!state.closed) fail("Local speech detection stopped. Run bin/setup-audio, then use /m again.");
  });
  worker.stdin.on("error", () => {});

  function feedWorker(audioBase64) {
    if (state.closed || !worker.stdin.writable) return;
    if (worker.stdin.writableLength > FRAME_BYTES * 100) {
      fail("Local speech detection fell behind; voice was stopped to avoid losing speech.");
      return;
    }
    const pcm = Buffer.from(audioBase64, "base64");
    for (let offset = 0; offset + FRAME_BYTES <= pcm.length; offset += FRAME_BYTES) {
      worker.stdin.write(
        JSON.stringify({ type: "input", audio: pcm.subarray(offset, offset + FRAME_BYTES).toString("base64") }) + "\n",
      );
    }
  }

  // A live microphone that delivers nothing is indistinguishable from silence,
  // so warn (without stopping voice) when no PCM arrives after media is ready.
  let lastPcmAt = 0;
  let micNotice = false;
  const watchdog = setInterval(() => {
    if (state.closed || !readyDone || !state.armed) return;
    if (!micNotice && performance.now() - lastPcmAt > 5000) {
      micNotice = true;
      onNotice(
        "No microphone audio is arriving. Check the microphone device and permission, then press /m again.",
      );
    }
  }, 1000);
  watchdog.unref?.();

  send({ type: "media.start", inputWav: inputWav || undefined, browser: browser || undefined });

  return {
    ready,
    get assistantActive() {
      return state.assistantActive;
    },
    createOffer(timeoutMs = 20_000) {
      if (state.closed) return Promise.reject(new VoiceError("Voice media is closed."));
      state.connected = false;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.pendingOffer = undefined;
          reject(new VoiceError("The media host did not produce a WebRTC offer in time."));
        }, timeoutMs);
        state.pendingOffer = { resolve, reject, timer };
        send({ type: "media.connect" });
      });
    },
    answer(sdp) {
      send({ type: "media.answer", sdp });
    },
    waitConnected(timeoutMs = 30_000) {
      if (state.connected) return Promise.resolve();
      if (state.closed) return Promise.reject(new VoiceError("Voice media is closed."));
      return new Promise((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            state.pendingConnected.delete(entry);
            reject(new VoiceError("The WebRTC connection did not reach connected in time."));
          }, timeoutMs),
        };
        state.pendingConnected.add(entry);
      });
    },
    send(event) {
      send({ type: "media.send", event });
    },
    mute(muted) {
      send({ type: "media.mute", muted });
    },
    sleep() {
      state.connected = false;
      send({ type: "media.close" });
    },
    async close() {
      if (state.closed) return;
      state.closed = true;
      clearInterval(watchdog);
      for (const entry of state.pendingConnected) {
        clearTimeout(entry.timer);
        entry.reject(new VoiceError("Voice media closed."));
      }
      state.pendingConnected.clear();
      if (state.pendingOffer) {
        clearTimeout(state.pendingOffer.timer);
        state.pendingOffer.reject(new VoiceError("Voice media closed."));
        state.pendingOffer = undefined;
      }
      try {
        helper.stdin.write(JSON.stringify({ type: "media.stop" }) + "\n");
      } catch {}
      await Promise.all(children.map((child) => endChild(child)));
    },
  };
}

async function endChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin.end();
  } catch {}
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
