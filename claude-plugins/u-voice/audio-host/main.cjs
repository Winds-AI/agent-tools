// A private, never-shown Chromium renderer. The parent owns authentication and
// passes only a temporary localhost URL over stdin, never on the command line.
const { app, BrowserWindow, session, systemPreferences } = require('electron');
const { join } = require('node:path');
const { parseConfiguration, sameOrigin, allowMedia, windowOptions } = require('./policy.cjs');

// Chromium reads these before 'ready', so they are set at load, not after the
// stdin configuration arrives. One hidden page needs no GPU, and keeping the
// GPU, audio and network services in the main process cuts 5 processes to 2
// and memory by about 30% (measured on macOS: 100 MB to 71 MB footprint, CPU
// unchanged, echo cancellation still on). A crash in any of them now ends the
// host, which the plugin already reports as voice stopping.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let window;
let closing = false;
let configured = false;
let input = '';
let configurationDeadline;
const emit = event => {
  if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(event) + '\n');
};

function stop(code = 0) {
  if (closing) return;
  closing = true;
  clearTimeout(configurationDeadline);
  // Destroying the renderer also releases its microphone and WebRTC transports;
  // it must not depend on a responsive page or an unload handler.
  try { window?.destroy(); } catch {}
  app.exit(code);
}

function fail(code) {
  if (closing) return;
  const messages = {
    permission: 'Microphone permission denied. Allow Electron in your system microphone settings, then retry /v.',
    configuration: 'Invalid background audio configuration.',
    startup: 'Could not start background audio. On Linux, a desktop display and working audio service are required.',
    renderer: 'Background audio stopped unexpectedly. Use /v to reconnect.',
    page: 'Could not reach the local voice helper. On WSL, check Windows-to-WSL localhost forwarding.',
  };
  emit({ type: 'host.error', code, message: messages[code] || messages.startup });
  stop(1);
}

async function start(raw) {
  let config;
  try { config = parseConfiguration(raw); } catch { fail('configuration'); return; }
  app.setName('U-voice');
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
  app.setPath('userData', config.profilePath);
  app.setPath('sessionData', join(config.profilePath, 'session'));
  if (config.syntheticWav) {
    app.commandLine.appendSwitch('use-fake-device-for-media-stream');
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', config.syntheticWav + '%noloop');
  }
  await app.whenReady();
  if (closing) return;
  if (process.platform === 'darwin') {
    app.dock?.hide();
    if (!config.syntheticWav && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      emit({ type: 'host.permission', message: 'Allow microphone access in the macOS permission prompt (Electron).' });
      if (!await systemPreferences.askForMediaAccess('microphone')) { fail('permission'); return; }
    }
  } else if (process.platform === 'win32' && !config.syntheticWav &&
             ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('microphone'))) {
    fail('permission'); return;
  }
  if (closing) return;
  emit({ type: 'host.starting' });
  const partition = 'uvoice-audio'; // in-memory; never shares the user's browser profile
  const audioSession = session.fromPartition(partition);
  audioSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window?.webContents && allowMedia(permission, details, config.origin));
  });
  audioSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return contents === window?.webContents && allowMedia(permission, details, config.origin, requestingOrigin);
  });
  window = new BrowserWindow(windowOptions(partition));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url, config.origin)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!sameOrigin(url, config.origin)) event.preventDefault();
  });
  window.webContents.on('render-process-gone', () => fail('renderer'));
  window.on('unresponsive', () => fail('renderer'));
  window.on('closed', () => { window = undefined; stop(); });
  // Synthetic offline fixtures must not play test tones through real speakers.
  if (config.suppressTestPlayback) window.webContents.setAudioMuted(true);
  try { await window.loadURL(config.url); } catch { fail('page'); return; }
  if (!closing) emit({ type: 'host.ready', hidden: !window.isVisible() });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 64_000) { fail('configuration'); return; }
  let end;
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1);
    if (configured) { if (line === 'stop') stop(); continue; }
    configured = true;
    clearTimeout(configurationDeadline);
    let value;
    try { value = JSON.parse(line); } catch { fail('configuration'); return; }
    void start(value).catch(() => fail('startup'));
  }
});
process.stdin.on('end', () => stop());
process.stdin.on('error', () => stop());
process.stdout.on('error', () => stop());
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
app.on('window-all-closed', () => stop());
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'Audio Service' || details.name === 'Audio Service') fail('renderer');
});
configurationDeadline = setTimeout(() => fail('configuration'), 15_000);
