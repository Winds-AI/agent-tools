import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Unit-level checks for the helper's platform selection logic, executed from
// this repository wherever it runs (macOS, Linux, or WSL with Windows browsers).
const helperSource = await readFile(
  fileURLToPath(new URL("../media/chromium-helper.mjs", import.meta.url)),
  "utf8",
);

test("helper knows Windows browsers for WSL, plus native platform lists", () => {
  assert.match(helperSource, /WSL_WINDOWS_BROWSERS/);
  assert.match(helperSource, /\/mnt\/c\/Program Files\/Google\/Chrome\/Application\//);
  assert.match(helperSource, /msedge\.exe/);
  assert.match(helperSource, /MACOS_BROWSERS/);
  assert.match(helperSource, /LINUX_BROWSERS/);
  assert.match(helperSource, /WINDOWS_BROWSERS/);
});

test("helper resolves the Windows temp directory through cmd.exe and wslpath", () => {
  assert.match(helperSource, /System32\/cmd\.exe/);
  assert.match(helperSource, /wslpath/);
});

test("helper forwards the overflow notice from the page", () => {
  assert.match(helperSource, /media\.overflow/);
});

test("page caps the connection replay and reports the overflow", async () => {
  const page = await readFile(
    fileURLToPath(new URL("../media/page.html", import.meta.url)),
    "utf8",
  );
  // 10 s of 24 kHz samples for the connect backlog, inside a 20 s ring.
  assert.match(page, /this\.capacity = 480000/);
  assert.match(page, /REPLAY_CAP = 240000/);
  assert.match(page, /overflow/);
  // Edge reports "completed" instead of "connected".
  assert.match(page, /"completed"/);
});
