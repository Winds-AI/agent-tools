import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * Chromium media host for pi-voice.
 *
 * Node owns authentication and call creation; this process owns the microphone,
 * speakers, WebRTC and Opus, because Node has no RTCPeerConnection. It speaks
 * JSON lines on stdio, and the embedded page talks to it over loopback HTTP:
 *
 *   helper -> extension : media.state, media.offer, media.connected, media.pcm,
 *                         media.event, media.audio, media.error
 *   extension -> helper : media.start, media.connect, media.answer, media.send,
 *                         media.mute, media.close, media.stop
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, "page.html"), "utf8");

const MACOS_BROWSERS = [
  {
    name: "Google Chrome",
    commands: ["google-chrome"],
    paths: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ],
  },
  {
    name: "Chromium",
    commands: ["chromium"],
    paths: [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      join(homedir(), "Applications", "Chromium.app", "Contents", "MacOS", "Chromium"),
    ],
  },
];

const LINUX_BROWSERS = [
  { name: "Google Chrome", commands: ["google-chrome", "google-chrome-stable"], paths: [] },
  { name: "Chromium", commands: ["chromium", "chromium-browser"], paths: [] },
];

const WINDOWS_BROWSERS = [
  {
    name: "Google Chrome",
    commands: ["chrome.exe"],
    paths: [
      process.env.ProgramFiles && join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
      process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ],
  },
  {
    name: "Microsoft Edge",
    commands: ["msedge.exe"],
    paths: [
      process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    ],
  },
];

let browser;
let server;
let profileDirectory;
let started = false;
let stopping = false;
let armed = false;
let inputWav;
const pendingCommands = [];

const input = createInterface({ input: process.stdin });
input.on("line", (line) => void handleLine(line));
input.on("close", () => void stop());
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function fail(message) {
  emit({ type: "media.error", message, fatal: true });
  void stop();
}

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail("invalid media command");
    return;
  }
  try {
    switch (message.type) {
      case "media.start":
        await start(message);
        break;
      case "media.connect":
      case "media.answer":
      case "media.send":
      case "media.mute":
      case "media.close":
      case "media.stop": {
        if (!started) throw new Error("media host is not started");
        // The page speaks bare command names (connect, answer, send, ...).
        pendingCommands.push({ ...message, type: message.type.replace(/^media\./, "") });
        if (message.type === "media.stop") {
          setTimeout(() => {
            if (!stopping) void stop();
          }, 250);
        }
        break;
      }
      default:
        throw new Error("unsupported media command: " + String(message.type));
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function start(message) {
  if (started) throw new Error("media host is already started");
  started = true;
  inputWav = typeof message.inputWav === "string" ? message.inputWav : undefined;
  const browserOverride = typeof message.browser === "string" && message.browser.trim() ? message.browser.trim() : undefined;

  emit({ type: "media.state", state: "starting", detail: "Starting Chromium media host" });

  server = createServer(handleRequest);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unable to resolve the media port");

  profileDirectory = mkdtempSync(join(tmpdir(), "pi-voice-browser-"));
  const selected = findBrowser(browserOverride);
  const url = "http://127.0.0.1:" + address.port + "/";
  const args = [
    "--headless=new",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=" + profileDirectory,
    url,
  ];
  emit({ type: "media.state", state: "starting", detail: "Starting " + selected.name });
  browser = spawn(selected.command, args, { stdio: "ignore" });
  browser.once("error", (error) => {
    if (!stopping) fail("Unable to start " + selected.name + ": " + error.message);
  });
  browser.once("exit", (code, signal) => {
    if (!stopping && started) {
      fail(selected.name + " exited unexpectedly (" + String(signal ?? code ?? "unknown") + ")");
    }
  });

  const armDeadline = Date.now() + 25_000;
  while (!armed && Date.now() < armDeadline) {
    await delay(100);
    if (stopping) return;
  }
  if (!armed) throw new Error("the media page did not become ready (microphone permission?)");
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      const page = PAGE.replace('"__INPUT_WAV__"', JSON.stringify(inputWav ?? ""));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(page);
      return;
    }
    if (request.method === "GET" && url.pathname === "/command") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(pendingCommands.splice(0)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/input.wav") {
      if (!inputWav) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" });
      response.end(readFileSync(inputWav));
      return;
    }
    if (request.method === "POST" && url.pathname === "/offer") {
      const body = await readJson(request);
      if (typeof body.sdp !== "string") throw new Error("offer requires sdp");
      emit({ type: "media.offer", sdp: body.sdp });
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/pcm") {
      const body = await readJson(request);
      if (typeof body.audio === "string") emit({ type: "media.pcm", audio: body.audio });
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/event") {
      const event = await readJson(request);
      response.writeHead(204);
      response.end();
      handlePageEvent(event);
      return;
    }
    response.writeHead(404);
    response.end();
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
}

function handlePageEvent(event) {
  if (!event || typeof event.kind !== "string") return;
  switch (event.kind) {
    case "state":
      if (event.state === "armed") {
        armed = true;
        emit({ type: "media.state", state: "armed" });
      } else {
        emit({ type: "media.state", state: event.state });
      }
      break;
    case "connected":
      emit({ type: "media.connected" });
      break;
    case "dc":
      emit({ type: "media.event", data: event.data });
      break;
    case "audio":
      emit({ type: "media.audio", active: Boolean(event.active) });
      break;
    case "catchup":
      emit({ type: "media.catchup", outputMs: event.outputMs, consumedMs: event.consumedMs });
      break;
    case "buffered":
      emit({ type: "media.buffered", ms: event.ms });
      break;
    case "error":
      emit({ type: "media.error", message: String(event.message ?? "media error"), fatal: event.fatal !== false });
      if (event.fatal !== false) void stop();
      break;
    case "dc-open":
    case "dc-close":
    case "muted":
    case "pc-state":
      break;
    default:
      break;
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4_000_000) {
        reject(new Error("media event is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on("error", reject);
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  pendingCommands.length = 0;
  input.close();
  process.stdin.pause();
  if (browser && browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill();
    await Promise.race([exited, delay(2000)]);
  }
  browser = undefined;
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
  }
  if (profileDirectory) {
    const prefix = join(tmpdir(), "pi-voice-browser-");
    if (profileDirectory.startsWith(prefix)) {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          rmSync(profileDirectory, { recursive: true, force: true });
          break;
        } catch {
          await delay(100);
        }
      }
    }
    profileDirectory = undefined;
  }
  emit({ type: "media.state", state: "stopped" });
  process.exit(0);
}

function findBrowser(override) {
  if (override) return { name: "configured Chromium browser", command: override };
  const candidates =
    process.platform === "darwin"
      ? MACOS_BROWSERS
      : process.platform === "win32"
        ? WINDOWS_BROWSERS
        : LINUX_BROWSERS;
  for (const candidate of candidates) {
    const installedPath = candidate.paths.find((path) => typeof path === "string" && existsSync(path));
    if (installedPath) return { name: candidate.name, command: installedPath };
    const installedCommand = candidate.commands.find(commandExists);
    if (installedCommand) return { name: candidate.name, command: installedCommand };
  }
  throw new Error(
    "No supported Chromium browser was found; install Chrome or Chromium, or set PI_VOICE_BROWSER",
  );
}

function commandExists(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { stdio: "ignore", windowsHide: true });
  return result.status === 0;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
