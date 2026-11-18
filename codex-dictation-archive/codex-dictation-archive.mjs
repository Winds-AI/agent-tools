#!/usr/bin/env node

// codex-dictation-archive — keep every Codex app dictation (audio + transcript).
//
// The Codex desktop app keeps only the newest 20 dictations in
// ~/.codex/dictation-history and deletes older ones. This script copies each
// finished dictation into an archive folder that only ever grows:
//   - file-change events (fs.watch) copy a dictation as soon as it finishes;
//   - a full scan at startup and every 60 s catches anything events missed.
// It only reads Codex's folder and never writes to it.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCAN_INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 300;
const LOG_MAX_BYTES = 1_000_000;
const TASK_NAME = "Codex Dictation Archive";
const AGENT_LABEL = "ai.winds.codex-dictation-archive";

const USAGE = `Usage: node codex-dictation-archive.mjs [command] [--archive <dir>]

Commands:
  (none)      Watch and archive until stopped
  --once      Archive what is there now, then exit
  install     Start automatically at login (and now)
  uninstall   Stop and remove the login item

--archive <dir>  Archive folder (default: ~/dictation-archive)
CODEX_HOME is honored for the Codex folder (default: ~/.codex).`;

function codexHome() {
  const env = process.env.CODEX_HOME;
  return env && env.trim() !== "" ? env : join(homedir(), ".codex");
}

function parseArgs(argv) {
  const out = { command: "watch", archive: join(homedir(), "dictation-archive") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.command = "help";
    else if (a === "--once") out.command = "once";
    else if (a === "install" || a === "uninstall") out.command = a;
    else if (a === "--archive" && argv[i + 1]) out.archive = argv[++i];
    else if (a.startsWith("--archive=")) out.archive = a.slice("--archive=".length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  out.archive = resolve(out.archive);
  return out;
}

// ---------- logging ----------

let logFile = null;

async function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  if (!logFile) return;
  try {
    const st = await fs.stat(logFile).catch(() => null);
    if (st && st.size > LOG_MAX_BYTES) await fs.rename(logFile, `${logFile}.old`);
    await fs.appendFile(logFile, line);
  } catch {}
}

// ---------- archiving one dictation ----------

const EXT_BY_MIME = {
  "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/aac": "aac",
  "audio/wav": "wav", "audio/wave": "wav", "audio/x-wav": "wav",
};
const audioExt = (mime = "") => EXT_BY_MIME[mime.split(";")[0].trim().toLowerCase()] ?? "webm";

/** Deterministic, readable folder name: UTC start time + first 8 chars of the id. */
function archiveName(meta) {
  const t = new Date(meta.createdAtMs).toISOString().slice(0, 19).replace("T", "_").replaceAll(":", "-");
  const id = String(meta.id).replace(/[^A-Za-z0-9-]/g, "").slice(0, 8);
  return `${t}Z_${id}`;
}

/** Codex's audio chunks, in recording order. Joining them gives the full file (Codex's own download does the same). */
async function listChunks(dir) {
  const names = await fs.readdir(dir);
  return names
    .map((n) => ({ n, m: /^(\d+)\.chunk$/.exec(n) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => join(dir, x.n));
}

async function joinChunks(chunks, target) {
  const fh = await fs.open(target, "w");
  try {
    for (const c of chunks) await fh.writeFile(await fs.readFile(c));
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeAtomic(target, data) {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
}

/** Copy one Codex dictation folder into the archive. Returns what happened and the archive folder name. */
async function archiveOne(srcDir, archiveRoot) {
  let raw;
  try {
    raw = await fs.readFile(join(srcDir, "metadata.json"), "utf8");
  } catch {
    return { result: "skip" }; // not a dictation folder, or Codex already deleted it
  }
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return { result: "skip" }; // mid-write; the next event or scan retries
  }
  if (!meta.id || !meta.createdAtMs || meta.status === "recording") return { result: "skip" };

  const chunks = await listChunks(srcDir);
  const audioName = `audio.${audioExt(meta.mimeType)}`;
  const folder = archiveName(meta);
  const dest = join(archiveRoot, folder);

  if (await exists(dest)) {
    // Already archived. Codex writes the transcript after the recording
    // finishes (and again on a retry), so keep metadata.json and the audio current.
    let changed = false;
    const old = await fs.readFile(join(dest, "metadata.json"), "utf8").catch(() => null);
    if (old !== raw) {
      await writeAtomic(join(dest, "metadata.json"), raw);
      changed = true;
    }
    if (chunks.length) {
      const want = (await Promise.all(chunks.map((c) => fs.stat(c)))).reduce((s, x) => s + x.size, 0);
      const have = (await fs.stat(join(dest, audioName)).catch(() => null))?.size;
      if (have !== want) {
        const tmp = join(dest, `${audioName}.${randomUUID()}.tmp`);
        try {
          await joinChunks(chunks, tmp);
          await fs.rename(tmp, join(dest, audioName));
        } finally {
          await fs.rm(tmp, { force: true });
        }
        changed = true;
      }
    }
    return { result: changed ? "updated" : "same", folder };
  }

  // New: build in a temp folder, then rename into place in one step.
  const tmpDir = join(archiveRoot, `.tmp-${randomUUID()}`);
  try {
    await fs.mkdir(tmpDir);
    if (chunks.length) await joinChunks(chunks, join(tmpDir, audioName));
    await fs.writeFile(join(tmpDir, "metadata.json"), raw);
    await fs.rename(tmpDir, dest);
    return { result: "archived", folder };
  } catch (err) {
    if (await exists(dest)) return { result: "same", folder }; // another run got there first
    throw err;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const exists = (p) => fs.access(p).then(() => true, () => false);

// ---------- watch + scan ----------

function createArchiver(sourceRoot, archiveRoot) {
  const dirty = new Set();
  let timer = null;
  let running = Promise.resolve();

  async function handle(name) {
    try {
      const { result, folder } = await archiveOne(join(sourceRoot, name), archiveRoot);
      if (result === "archived" || result === "updated") await log(`${result} ${folder}`);
    } catch (err) {
      await log(`error ${name}: ${err.message}`);
    }
  }

  function drain() {
    timer = null;
    const names = [...dirty];
    dirty.clear();
    running = running.then(async () => {
      for (const n of names) await handle(n);
    });
    return running;
  }

  return {
    mark(name) {
      dirty.add(name);
      if (!timer) timer = setTimeout(drain, DEBOUNCE_MS);
    },
    async scan() {
      const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isDirectory()) dirty.add(e.name);
      if (timer) clearTimeout(timer);
      await drain();
    },
  };
}

async function runWatch(archiveRoot, once) {
  const sourceRoot = join(codexHome(), "dictation-history");
  await fs.mkdir(archiveRoot, { recursive: true });
  logFile = join(archiveRoot, "archiver.log");
  const archiver = createArchiver(sourceRoot, archiveRoot);

  if (once) {
    await archiver.scan();
    return;
  }

  await log(`started: ${sourceRoot} -> ${archiveRoot}`);
  process.on("uncaughtException", (err) => void log(`uncaught: ${err.stack ?? err}`));
  process.on("unhandledRejection", (err) => void log(`unhandled: ${err?.stack ?? err}`));

  let watcher = null;
  function ensureWatcher() {
    if (watcher) return;
    try {
      watcher = watch(sourceRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return void archiver.scan(); // the OS lost track: rescan
        const first = String(filename).split(/[\\/]/)[0];
        if (first) archiver.mark(first);
      });
      watcher.on("error", (err) => {
        void log(`watcher error: ${err.message}`);
        watcher?.close();
        watcher = null; // recreated on the next scan
      });
    } catch {
      watcher = null; // Codex folder not there yet; retried on the next scan
    }
  }

  ensureWatcher();
  await archiver.scan();
  setInterval(() => {
    ensureWatcher();
    void archiver.scan();
  }, SCAN_INTERVAL_MS);
}

// ---------- install / uninstall ----------

/** Where the installed copy lives, so the login item doesn't depend on where the repo is cloned. */
function installDir() {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "codex-dictation-archive");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "codex-dictation-archive");
  throw new Error("install supports Windows and macOS only");
}

const psQuote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

function powershell(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
}

/** Stopping the task ends conhost but not its node child, so end that too. */
function stopWindowsTask(script) {
  powershell(`
    Stop-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${psQuote(script)}) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  `);
}

function plistPath() {
  return join(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

async function install(archiveRoot) {
  const dir = installDir();
  await fs.mkdir(dir, { recursive: true });
  const script = join(dir, "codex-dictation-archive.mjs");
  if (process.platform === "win32") stopWindowsTask(script); // reinstall: stop the old copy first
  await fs.copyFile(fileURLToPath(import.meta.url), script);
  await fs.mkdir(archiveRoot, { recursive: true });
  const node = process.execPath;

  if (process.platform === "win32") {
    const args = `--headless "${node}" "${script}" --archive "${archiveRoot}"`;
    powershell(`
      $ErrorActionPreference = 'Stop'
      $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psQuote(args)}
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
      $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
      Start-ScheduledTask -TaskName ${psQuote(TASK_NAME)}
    `);
    console.log(`Installed Task Scheduler task "${TASK_NAME}" (runs at login, started now).`);
  } else if (process.platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(script)}</string>
    <string>--archive</string>
    <string>${xmlEscape(archiveRoot)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${xmlEscape(join(archiveRoot, "archiver.stderr.log"))}</string>
</dict>
</plist>
`;
    const p = plistPath();
    await fs.mkdir(dirname(p), { recursive: true });
    const domain = `gui/${process.getuid()}`;
    try { execFileSync("launchctl", ["bootout", `${domain}/${AGENT_LABEL}`], { stdio: "ignore" }); } catch {}
    await fs.writeFile(p, plist);
    execFileSync("launchctl", ["bootstrap", domain, p]);
    console.log(`Installed LaunchAgent ${AGENT_LABEL} (runs at login, started now).`);
  } else {
    throw new Error("install supports Windows and macOS only");
  }
  console.log(`Archive: ${archiveRoot}`);
  console.log(`Installed copy: ${script}`);
}

async function uninstall() {
  if (process.platform === "win32") {
    stopWindowsTask(join(installDir(), "codex-dictation-archive.mjs"));
    powershell(`
      Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue
    `);
  } else if (process.platform === "darwin") {
    try { execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${AGENT_LABEL}`], { stdio: "ignore" }); } catch {}
    await fs.rm(plistPath(), { force: true });
  } else {
    throw new Error("uninstall supports Windows and macOS only");
  }
  await fs.rm(installDir(), { recursive: true, force: true });
  console.log("Uninstalled. The archive folder was left untouched.");
}

// ---------- main ----------

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === "help") console.log(USAGE);
  else if (opts.command === "install") await install(opts.archive);
  else if (opts.command === "uninstall") await uninstall();
  else await runWatch(opts.archive, opts.command === "once");
} catch (err) {
  console.error(err.message);
  console.error(USAGE);
  process.exit(1);
}
