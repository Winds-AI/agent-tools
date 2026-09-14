/**
 * Live smoke test: real auth, real media host, real GPT-Live call.
 *
 *   npm run smoke
 *
 * It synthesizes a spoken request with the macOS `say` voice, feeds it through
 * the Chromium media host, and expects GPT-Live to delegate to the client.
 * It then answers the delegation and requires the reply to be spoken back.
 * This uses the ChatGPT subscription through the Codex realtime endpoint and
 * consumes voice-minutes; it does not touch Pi itself.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCodexAuth } from "../src/auth.mjs";
import { createLiveCall } from "../src/call.mjs";
import { openMedia } from "../src/media.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REQUEST =
  "Please inspect this project and tell me how many source files it contains. Just say the number.";
const ANSWER = "The project contains 42 source files.";
const deadlineMs = 75_000;

function makeWav() {
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-smoke-"));
  const aiff = join(directory, "ask.aiff");
  const wav = join(directory, "ask.wav");
  execFileSync("say", ["-v", "Samantha", "-o", aiff, REQUEST], { stdio: "ignore" });
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav], { stdio: "ignore" });
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

  let live = false;
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
  live = true;
  console.log(`# call connected${call.callId ? " (" + call.callId.split("/").pop() + ")" : ""}`);

  setTimeout(() => fail("timed out before the delegation result was spoken"), deadlineMs);
}

main().catch((error) => {
  console.error("SMOKE FAIL:", error?.message ?? error);
  process.exit(1);
});
