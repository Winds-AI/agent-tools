import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../audio-host');
const APP_FILES = ['package.json', 'main.cjs', 'policy.cjs'];
const HOST_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE',
  'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY', 'PULSE_SERVER', 'PULSE_COOKIE', 'PIPEWIRE_REMOTE',
]);

// Do not give the audio renderer's parent process model keys, Codex credentials,
// shell startup hooks, NODE_OPTIONS, or ELECTRON_RUN_AS_NODE from the terminal.
export function audioEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => HOST_ENV.has(key.toUpperCase()) && typeof value === 'string'));
}

export async function detectAudioTarget({ env = process.env, platform = process.platform, arch = process.arch, run = runFile, signal } = {}) {
  const wsl = platform === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  if (!wsl) return { platform, arch, wsl: false, cacheRoot: env.UVOICE_CACHE_DIR ? resolve(env.UVOICE_CACHE_DIR) : undefined };
  // WSL must use Windows audio devices, while the helper/auth stay in Linux.
  // Query values, never execute a command assembled from user input.
  let info;
  try {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[pscustomobject]@{cache=[Environment]::GetFolderPath("LocalApplicationData");arch=if($env:PROCESSOR_ARCHITEW6432){$env:PROCESSOR_ARCHITEW6432}else{$env:PROCESSOR_ARCHITECTURE}} | ConvertTo-Json -Compress'],
    { timeout: 10_000, windowsHide: true, signal });
    info = JSON.parse(result.stdout.trim());
    const windowsArch = { AMD64: 'x64', ARM64: 'arm64' }[String(info.arch).toUpperCase()];
    if (!info.cache || !windowsArch) throw new Error();
    const mapped = await run('wslpath', ['-u', info.cache], { timeout: 3000, signal });
    return { platform: 'win32', arch: windowsArch, wsl: true, cacheRoot: join(mapped.stdout.trim(), 'uvoice', 'Cache') };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error('WSL needs Windows interop (powershell.exe and wslpath) to start background audio.');
  }
}

export async function hostPath(path, target, { run = runFile, signal } = {}) {
  if (!target.wsl) return path;
  return (await run('wslpath', ['-w', path], { timeout: 3000, signal })).stdout.trim();
}

export async function prepareAudioFiles(runtimeDir, target, { syntheticWav, signal } = {}) {
  signal?.throwIfAborted();
  const profiles = join(runtimeDir, 'profiles');
  await mkdir(profiles, { recursive: true });
  const profilePath = await mkdtemp(join(profiles, 'voice-'));
  // WSL should not ask Windows Electron to execute code over a \\wsl$ UNC share.
  // Copy this plugin's small host into the per-call Windows-local directory.
  let application = appRoot;
  if (target.wsl) {
    application = join(profilePath, 'host');
    await mkdir(application);
    for (const name of APP_FILES) await copyFile(join(appRoot, name), join(application, name));
  }
  let wav = syntheticWav ? resolve(syntheticWav) : undefined;
  if (wav && target.wsl) {
    const copied = join(profilePath, 'synthetic.wav');
    await copyFile(wav, copied);
    wav = copied;
  }
  return { profilePath, application, wav };
}
