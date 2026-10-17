import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { promisify } from 'node:util';
import zip from '../vendor/extract-zip.cjs';

const manifest = JSON.parse(await readFile(new URL('./electron-runtime-manifest.json', import.meta.url), 'utf8'));
const OFFICIAL_BASE = `https://github.com/electron/electron/releases/download/v${manifest.version}/`;
const MARKER = '.uvoice-runtime.json';
const abortError = () => Object.assign(new Error('Electron setup canceled.'), { name: 'AbortError' });
const fail = (message, code) => Object.assign(new Error(message), { code });
const checkAbort = (signal) => { if (signal?.aborted) throw abortError(); };
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
const progress = (callback, event) => { try { callback?.(event); } catch { /* UI observers cannot break installation. */ } };

function defaultCacheRoot(platform) {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'uvoice');
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (!local || !path.isAbsolute(local)) throw fail('Pass an absolute cacheRoot for the Windows runtime, or set LOCALAPPDATA.');
    return path.join(local, 'uvoice', 'Cache');
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.cache'), 'uvoice');
}

async function validRuntime(runtimeDir, target, version, platform) {
  try {
    const marker = JSON.parse(await readFile(path.join(runtimeDir, MARKER), 'utf8'));
    if (marker.version !== version || marker.sha256 !== target.sha256 || marker.asset !== target.asset) return false;
    await validateExecutable(runtimeDir, target.executable, platform);
    return true;
  } catch { return false; }
}

async function validateExecutable(runtimeDir, executable, platform) {
  const executablePath = path.join(runtimeDir, executable);
  if (!inside(await realpath(runtimeDir), await realpath(executablePath))) throw fail('Electron executable is outside its runtime directory.');
  const info = await stat(executablePath);
  if (!info.isFile() || info.size === 0) throw fail('Electron archive is missing its executable.');
  // A Windows executable on a WSL mount need not carry a POSIX executable bit.
  if (platform !== 'win32') await access(executablePath, constants.X_OK);
}

/** Pinned official release only; no package manager or external unzip at runtime. */
export function ensureElectronRuntime(options = {}) {
  return ensureElectronRuntimeFromSource(options, { manifest, baseUrl: OFFICIAL_BASE });
}

/** Separate source seam for offline fixtures. The production API never accepts these overrides. */
export async function ensureElectronRuntimeFromSource({
  platform = process.platform, arch = process.arch, cacheRoot, signal, onProgress,
} = {}, {
  manifest: sourceManifest, baseUrl, fetch: fetchImpl = globalThis.fetch,
  attempts = 3, downloadTimeoutMs = 300_000, idleTimeoutMs = 30_000,
  extractTimeoutMs = 120_000, retryDelayMs = 500,
} = {}) {
  checkAbort(signal);
  const target = sourceManifest?.targets?.[`${platform}-${arch}`];
  if (!target) throw fail('Unsupported Electron target. Use macOS, Linux, or Windows with an arm64 or x64 Node 22 installation.', 'UNSUPPORTED_TARGET');
  const version = sourceManifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version) || target.asset !== `electron-v${version}-${platform}-${arch}.zip` ||
      !/^[a-f0-9]{64}$/.test(target.sha256) || !target.executable ||
      target.executable.includes('\\') || path.isAbsolute(target.executable) || target.executable.split('/').includes('..')) {
    throw fail('Invalid pinned Electron manifest.');
  }
  cacheRoot ??= defaultCacheRoot(platform);
  if (!path.isAbsolute(cacheRoot)) throw fail('Electron cacheRoot must be an absolute native Node path.');
  progress(onProgress, { phase: 'download', message: 'Checking Electron runtime…' });
  const parent = path.join(cacheRoot, 'electron', version);
  const runtimeDir = path.join(parent, `${platform}-${arch}`);
  const result = { executablePath: path.join(runtimeDir, target.executable), runtimeDir };
  const ready = () => {
    progress(onProgress, { phase: 'ready', message: 'Electron runtime ready.' });
    return result;
  };
  if (await validRuntime(runtimeDir, target, version, platform)) { checkAbort(signal); return ready(); }
  try {
    // Never delete an existing directory: another process may have just completed it.
    await lstat(runtimeDir);
    if (await validRuntime(runtimeDir, target, version, platform)) return ready();
    throw fail('Cached Electron runtime is incomplete. Remove its platform directory from the U-voice cache and retry.', 'INVALID_CACHE');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let stage;
  try {
    await mkdir(parent, { recursive: true });
    stage = await mkdtemp(path.join(parent, `.${platform}-${arch}-`));
    const archivePath = path.join(stage, 'archive.zip');
    await download({ url: new URL(target.asset, baseUrl), archivePath, target, fetchImpl, signal, onProgress,
      attempts, downloadTimeoutMs, idleTimeoutMs, retryDelayMs });
    checkAbort(signal);
    progress(onProgress, { phase: 'extract', message: 'Extracting Electron runtime…' });
    const extracted = path.join(stage, 'runtime');
    await extractInWorker(archivePath, extracted, signal, extractTimeoutMs);
    checkAbort(signal);
    await validateExecutable(extracted, target.executable, platform);
    await writeFile(path.join(extracted, MARKER), JSON.stringify({ version, asset: target.asset, sha256: target.sha256 }));
    checkAbort(signal);
    try { await rename(extracted, runtimeDir); }
    catch (error) {
      // Atomic directory publication: a concurrent winner is already complete.
      if (!await validRuntime(runtimeDir, target, version, platform)) throw error;
    }
    return ready();
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw abortError();
    if (error.code === 'CHECKSUM_MISMATCH' || error.code === 'DOWNLOAD_FAILED' || error.code === 'EXTRACT_FAILED') throw error;
    throw fail('Could not install Electron. Check free disk space and cache directory permissions, then retry.');
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}

async function download({ url, archivePath, target, fetchImpl, signal, onProgress,
  attempts, downloadTimeoutMs, idleTimeoutMs, retryDelayMs }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    checkAbort(signal);
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(downloadTimeoutMs), ...(signal ? [signal] : [])]);
    let idleTimer;
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs); };
    let response;
    try {
      progress(onProgress, { phase: 'download', message: attempt ? 'Retrying Electron download…' : 'Downloading Electron runtime…', receivedBytes: 0 });
      resetIdle();
      response = await fetchImpl(url, { signal: combined });
      if (!response.ok || !response.body) throw fail('Download failed.');
      const length = Number(response.headers.get('content-length'));
      const total = Number.isSafeInteger(length) && length > 0 ? length : undefined;
      const hash = createHash('sha256');
      let received = 0;
      let lastProgress = 0;
      const report = () => progress(onProgress, { phase: 'download', message: 'Downloading Electron runtime…', receivedBytes: received,
        ...(total === undefined ? {} : { totalBytes: total }) });
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        resetIdle();
        received += chunk.length;
        if (received > 512 * 1024 * 1024) return callback(fail('Archive exceeds download limit.'));
        hash.update(chunk);
        if (Date.now() - lastProgress >= 250) { report(); lastProgress = Date.now(); }
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(archivePath, { flags: 'w', mode: 0o600 }), { signal: combined });
      if (hash.digest('hex') !== target.sha256) throw fail('Electron archive checksum mismatch. Retry setup; if it persists, update the U-voice plugin.', 'CHECKSUM_MISMATCH');
      report();
      return;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (error.code === 'CHECKSUM_MISMATCH') throw error;
      if (attempt + 1 === attempts) throw fail('Could not download Electron. Check your connection and retry.', 'DOWNLOAD_FAILED');
    } finally {
      clearTimeout(idleTimer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
    try { await delay(retryDelayMs * (attempt + 1), undefined, { signal }); }
    catch { throw abortError(); }
  }
}

async function extractInWorker(archivePath, dir, signal, timeoutMs) {
  checkAbort(signal);
  const worker = new Worker(new URL(import.meta.url), { workerData: { uvoiceExtract: true, archivePath, dir } });
  let complete = false;
  let timedOut = false;
  let workerError = false;
  const stop = () => { void worker.terminate(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await new Promise((resolve, reject) => {
      worker.on('message', (message) => { complete = message === 'ready'; });
      worker.on('error', () => { workerError = true; });
      worker.on('exit', (code) => {
        if (signal?.aborted) reject(abortError());
        else if (code !== 0 || !complete || timedOut || workerError) reject(fail('Could not safely extract Electron. Retry setup or update the U-voice plugin.', 'EXTRACT_FAILED'));
        else resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    await worker.terminate();
  }
}

// extract-zip 2.0.1 needs a preflight for symlinks. Parse with yauzl, never a custom ZIP parser.
// Reject writes beneath symlinks, duplicates, and links escaping the extraction root.
async function preflightArchive(archivePath, root) {
  const archive = await promisify(zip.openZip)(archivePath, { lazyEntries: true, strictFileNames: true });
  const names = new Set();
  const links = new Set();
  let expandedBytes = 0;
  try {
    await new Promise((resolve, reject) => {
      archive.on('error', reject);
      archive.on('end', resolve);
      archive.on('entry', async (entry) => {
        try {
          const name = entry.fileName.replace(/\/$/, '');
          if (!name || entry.fileName.includes('\\') || entry.fileName.includes(':') ||
              name.split('/').some((part) => part === '..' || part === '.' || !part) ||
              !inside(root, path.resolve(root, name)) || names.has(name)) throw fail('Unsafe archive path.');
          names.add(name);
          expandedBytes += entry.uncompressedSize;
          if (expandedBytes > 2 * 1024 ** 3 || names.size > 100_000) throw fail('Archive exceeds extraction limits.');
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
            if (entry.uncompressedSize > 4096) throw fail('Invalid archive symlink.');
            links.add(name);
          }
          archive.readEntry();
        } catch (error) { reject(error); archive.close(); }
      });
      archive.readEntry();
    });
    for (const name of names) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (links.has(parts.slice(0, i).join('/'))) throw fail('Archive writes beneath a symlink.');
      }
    }
    return links;
  } finally { archive.close(); }
}

if (!isMainThread && workerData?.uvoiceExtract) {
  try {
    const { archivePath, dir } = workerData;
    const links = await preflightArchive(archivePath, dir);
    await zip.extractZip(archivePath, { dir });
    for (const name of links) {
      if (!inside(await realpath(dir), await realpath(path.join(dir, name)))) throw fail('Unsafe extracted symlink.');
    }
    parentPort.postMessage('ready');
  } catch {
    // Never forward archive names, remote errors, or paths to UI output.
    process.exitCode = 1;
  }
}
