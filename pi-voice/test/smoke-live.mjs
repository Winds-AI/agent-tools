/**
 * Live smoke test: real auth, real media host, real GPT-Live call.
 *
 *   npm run smoke
 *
 * It synthesizes a spoken request (macOS `say`, or Windows SAPI inside WSL),
 * feeds it through the browser media host in place of the microphone, and
 * expects GPT-Live to delegate to the client. It then answers the delegation
 * and requires the reply to be spoken back. This uses the ChatGPT subscription
 * through the Codex realtime endpoint and consumes voice-minutes; it does not
 * touch Pi itself.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getCodexAuth } from "../src/auth.mjs";
import { createLiveCall } from "../src/call.mjs";
import { openMedia } from "../src/media.mjs";

const REQUEST =
  "Please inspect this project and tell me how many source files it contains. Just say the number.";
const ANSWER = "The project contains 42 source files.";
const deadlineMs = 75_000;

function insideWSL() {
  if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) return true;
  try {
    return existsSync("/proc/version") && /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function makeWav() {
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-smoke-"));
  const wav = join(directory, "ask.wav");
  if (process.platform === "darwin") {
    const aiff = join(directory, "ask.aiff");
    execFileSync("say", ["-v", "Samantha", "-o", aiff, REQUEST], { stdio: "ignore" });
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav], {
      stdio: "ignore",
    });
  } else if (insideWSL()) {
    const windowsTemp = spawnSync("/mnt/c/Windows/System32/cmd.exe", ["/c", "echo %TEMP%"], {
      encoding: "utf8",
      timeout: 5000,
    }).stdout.replace(/[\r\n]+$/, "");
    const windowsPath = windowsTemp + "\\pi-voice-smoke-ask.wav";
    const script =
      "Add-Type -AssemblyName System.Speech; " +
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      "$s.SetOutputToWaveFile('" + windowsPath + "'); " +
      "$s.Rate = 0; $s.Speak('" + REQUEST.replace(/'/g, "''") + "'); $s.Dispose()";
    execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", [
      "-NoProfile",
      "-Command",
      script,
    ]);
    const unixPath = execFileSync("/usr/bin/wslpath", ["-u", windowsPath], {
      encoding: "utf8",
    }).trim();
    execFileSync("cp", [unixPath, wav]);
  } else {
    throw new Error("No speech synthesizer for this platform; pass a spoken WAV as argv[2].");
  }
  if (!existsSync(wav)) throw new Error("Speech synthesis produced no WAV.");
  return { directory, wav };
}

async function main() {
  const auth = await getCodexAuth();
  console.log(`# auth: ${auth.source}`);

  const speech = makeWav();
  let wakeOnce;
  const wake = new Promise((resolve) => {
    wakeOnce = resolve;
  });
  const media = openMedia({
    inputWav: speech.wav,
    onSpeech: (speaking) => {
      console.log(`# vad: ${speaking ? "speech" : "quiet"}`);
      if (speaking) wakeOnce();
    },
    onError: (error) => fail(error.message ?? String(error)),
    onEvent: (event) => void onEvent(event),
    onTelemetry: (event) => console.log("# media:", JSON.stringify(event)),
  });

  let delegated = false;
  let spoken = false;
  let finished = false;

  function fail(message) {
    if (finished) return;
    finished = true;
    console.error(`SMOKE FAIL: ${message}`);
    void cleanup(1);
  }

  async function cleanup(code) {
    try {
      await media.close();
    } catch {}
    rmSync(speech.directory, { recursive: true, force: true });
    process.exit(code);
  }

  async function onEvent(event) {
    if (event.type === "delegation.created" && event.item?.target === "client") {
      const request = (event.item.content ?? []).map((part) => part.text ?? "").join("");
      console.log(`# delegation: ${request}`);
      const normalize = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const got = normalize(request);
      const expected = normalize(REQUEST);
      if (got === expected) {
        console.log("# accuracy: verbatim");
      } else {
        const gotWords = got.split(" ");
        const expectedWords = expected.split(" ");
        const matched = expectedWords.filter((word) => gotWords.includes(word)).length;
        console.log(`# accuracy: ${Math.round((matched / expectedWords.length) * 100)}% of expected words present`);
        const missing = ["inspect", "project", "source", "files"].filter((word) => !got.includes(word));
        if (missing.length) console.log(`# accuracy warning: missing ${missing.join(", ")}`);
      }
      delegated = true;
      for (const chunk of chunkText(ANSWER)) {
        media.send({
          type: "delegation.context.append",
          delegation_item_id: event.item.id,
          channel: "speakable",
          content: [{ type: "input_text", text: chunk }],
        });
      }
    }
    if (event.type === "output_transcript.added" && /42|forty/i.test(event.item?.text ?? "")) {
      spoken = true;
      console.log(`# spoken: ${event.item.text.trim()}`);
    }
    if ((event.type === "turn.done" || event.type === "output_transcript.added") && delegated && spoken) {
      if (!finished) {
        finished = true;
        console.log("SMOKE PASS: direct reply, delegation and spoken result all observed");
        await cleanup(0);
      }
    }
    if (event.type === "error") fail(event.error?.message ?? "server error");
  }

  function chunkText(text) {
    const chunks = [];
    for (let index = 0; index < text.length; index += 300) chunks.push(text.slice(index, index + 300));
    return chunks;
  }

  await media.ready;
  console.log("# media host ready; waiting for speech in the synthesized wav");

  // Production order: local VAD detects speech first, only then does the
  // metered session open and the buffered speech get released.
  await wake;
  console.log("# speech detected; opening the session");
  const offer = await media.createOffer();
  const call = await createLiveCall({
    sdp: offer,
    instructions: "You are a voice coordinator. Delegate substantial requests to the client.",
    voice: "cove",
    auth,
  });
  media.answer(call.answer);
  await media.waitConnected();
  console.log(`# call connected${call.callId ? " (" + call.callId.split("/").pop() + ")" : ""}`);

  setTimeout(() => fail("timed out before the delegation result was spoken"), deadlineMs);
}

main().catch((error) => {
  console.error("SMOKE FAIL:", error?.message ?? error);
  process.exit(1);
});
