const { isAbsolute } = require('node:path');

function parseConfiguration(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-zA-Z0-9_%.-]{24,}$/.test(value.url)) {
    throw new Error('Invalid local audio address.');
  }
  const url = new URL(value.url);
  if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535) throw new Error('Invalid local audio port.');
  if (typeof value.profilePath !== 'string' || !isAbsolute(value.profilePath)) throw new Error('Invalid audio profile.');
  if (value.syntheticWav !== undefined && (typeof value.syntheticWav !== 'string' || !isAbsolute(value.syntheticWav))) {
    throw new Error('Synthetic audio must be an absolute file path.');
  }
  if (value.suppressTestPlayback && !value.syntheticWav) throw new Error('Silent playback is only available with synthetic test audio.');
  return { url: url.href, origin: url.origin, profilePath: value.profilePath, syntheticWav: value.syntheticWav, suppressTestPlayback: value.suppressTestPlayback === true };
}

function sameOrigin(value, origin) {
  try { return new URL(value).origin === origin; } catch { return false; }
}

function allowMedia(permission, details, origin, requestingOrigin) {
  if (permission !== 'media' || !sameOrigin(requestingOrigin || details?.requestingUrl || details?.securityOrigin, origin)) return false;
  // Request callbacks use mediaTypes; check callbacks use mediaType. Deny
  // cameras, screen capture and unspecified device requests.
  if (Array.isArray(details?.mediaTypes)) return details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio');
  return details?.mediaType === 'audio';
}

function windowOptions(partition) {
  return {
    show: false,
    skipTaskbar: true,
    focusable: false,
    width: 320,
    height: 180,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  };
}

module.exports = { parseConfiguration, sameOrigin, allowMedia, windowOptions };
