import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { VoiceError } from "./live.mjs";

// A single warm worker owns VAD state, the pre-roll queue, and the tempo filter.
// JSON lines keep this boundary inspectable without coupling it to Pi or Live.
export function openProcessor({ onActivity, onAudio, onError }) {
  const child = spawn(
    fileURLToPath(new URL("../.venv/bin/python", import.meta.url)),
    ["-u", fileURLToPath(new URL("../audio/worker.py", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let closed = false;
  let readyDone = false;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = () => {
    if (closed) return;
    const error = new VoiceError(
      "Local voice audio failed. Run bin/setup-audio and check the microphone.",
    );
    if (!readyDone) {
      readyDone = true;
      rejectReady(error);
    } else onError(error);
  };
  const timer = setTimeout(fail, 10000);
  child.stderr.resume();
  child.on("error", fail);
  child.on("close", fail);
  child.stdin.on("error", fail);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (closed) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail();
      return;
    }
    if (event.type === "ready") {
      clearTimeout(timer);
      readyDone = true;
      resolveReady();
    } else if (event.type === "activity") onActivity(event);
    else if (event.type === "audio") onAudio(event);
    else if (event.type === "error") fail();
  });
  return {
    ready,
    send(event) {
      if (closed) return;
      if (child.stdin.writableLength > 48000 * 3) {
        fail();
        return;
      }
      child.stdin.write(JSON.stringify(event) + "\n");
    },
    close() {
      if (this.closing) return this.closing;
      closed = true;
      clearTimeout(timer);
      lines.close();
      if (!readyDone) {
        readyDone = true;
        rejectReady(new VoiceError("Audio startup cancelled."));
      }
      this.closing = new Promise((resolve) => {
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
      });
      return this.closing;
    },
  };
}
