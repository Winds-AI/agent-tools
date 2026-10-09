import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import yazl from 'yazl';
import { createRequire } from 'node:module';
import { ensureElectronRuntimeFromSource } from '../scripts/electron-runtime.mjs';
import { audioEnvironment } from '../scripts/audio-platform.mjs';

const require = createRequire(import.meta.url);
const { allowMedia, parseConfiguration, windowOptions } = require('../audio-host/policy.cjs');

async function temp() {
  return mkdtemp(join(tmpdir(), 'uvoice-electron-test-'));
}

function zipBuffer(entries) {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.body ?? ''), entry.name, { mode: entry.mode ?? 0o100644 });
  }
  zip.end();
  const chunks = [];
  zip.outputStream.on('data', chunk => chunks.push(chunk));
  return once(zip.outputStream, 'end').then(() => Buffer.concat(chunks));
}

async function fixtureServer(buffer, { slow = false } = {}) {
  let hits = 0;
  const server = createServer(async (_request, response) => {
    hits++;
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': buffer.length });
    if (slow) {
      response.write(buffer.subarray(0, 4));
      await new Promise(resolve => setTimeout(resolve, 100));
      response.end(buffer.subarray(4));
    } else response.end(buffer);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: new URL('http://127.0.0.1:' + server.address().port + '/'),
    hits: () => hits,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

function manifestFor(buffer, overrides = {}) {
  return { version: '44.5.1', targets: { 'linux-x64': { asset: 'electron-v44.5.1-linux-x64.zip', sha256: createHash('sha256').update(buffer).digest('hex'), executable: 'electron', ...overrides } } };
}

async function install(cacheRoot, server, manifest, options = {}) {
  return ensureElectronRuntimeFromSource({ platform: 'linux', arch: 'x64', cacheRoot, ...options }, { manifest, baseUrl: server.baseUrl, attempts: 1 });
}

test('extracts a pinned runtime, marks it, and reuses cache without network', async () => {
  const root = await temp();
  try {
    const buffer = await zipBuffer([{ name: 'electron', body: '#!/bin/sh\n', mode: 0o100755 }, { name: 'resources/default_app.asar', body: 'fixture' }]);
    const server = await fixtureServer(buffer);
    try {
      const events = [];
      const first = await install(root, server, manifestFor(buffer), { onProgress: event => events.push(event) });
      assert.equal(first.executablePath.endsWith('/electron'), true);
      assert.equal((await stat(first.executablePath)).isFile(), true);
      assert.equal(JSON.parse(await readFile(join(first.runtimeDir, '.uvoice-runtime.json'), 'utf8')).sha256, manifestFor(buffer).targets['linux-x64'].sha256);
      assert.ok(events.some(event => event.phase === 'download'));
      assert.ok(events.some(event => event.phase === 'extract'));
      assert.equal(events.at(-1).phase, 'ready');
      const second = await install(root, server, manifestFor(buffer));
      assert.equal(second.executablePath, first.executablePath);
      assert.equal(server.hits(), 1);
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only publishes one completed runtime during concurrent setup', async () => {
  const root = await temp();
  try {
    const buffer = await zipBuffer([{ name: 'electron', body: '#!/bin/sh\n', mode: 0o100755 }]);
    const server = await fixtureServer(buffer, { slow: true });
    try {
      const manifest = manifestFor(buffer);
      const [a, b] = await Promise.all([install(root, server, manifest), install(root, server, manifest)]);
      assert.equal(a.executablePath, b.executablePath);
      assert.equal(JSON.parse(await readFile(join(a.runtimeDir, '.uvoice-runtime.json'), 'utf8')).asset, 'electron-v44.5.1-linux-x64.zip');
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects checksum mismatch and leaves no published runtime', async () => {
  const root = await temp();
  try {
    const buffer = await zipBuffer([{ name: 'electron', body: '#!/bin/sh\n', mode: 0o100755 }]);
    const server = await fixtureServer(buffer);
    try {
      const manifest = manifestFor(buffer, { sha256: '0'.repeat(64) });
      await assert.rejects(() => install(root, server, manifest), /checksum/i);
      await assert.rejects(() => stat(join(root, 'electron/44.5.1/linux-x64')), /ENOENT/);
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation cleans incomplete staging', async () => {
  const root = await temp();
  try {
    const buffer = await zipBuffer([{ name: 'electron', body: '#!/bin/sh\n', mode: 0o100755 }]);
    const server = await fixtureServer(buffer, { slow: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    try {
      await assert.rejects(() => install(root, server, manifestFor(buffer), { signal: controller.signal }), /canceled/i);
      await assert.rejects(() => stat(join(root, 'electron/44.5.1/linux-x64')), /ENOENT/);
      const parent = join(root, 'electron/44.5.1');
      await mkdir(parent, { recursive: true });
      assert.deepEqual((await readdir(parent)).filter(name => name.startsWith('.linux-x64-')), []);
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects unsupported targets and unsafe archives', async () => {
  const root = await temp();
  try {
    await assert.rejects(() => ensureElectronRuntimeFromSource({ platform: 'aix', arch: 'ppc', cacheRoot: root }, { manifest: { version: '44.5.1', targets: {} }, baseUrl: new URL('http://127.0.0.1/') }), /Unsupported/);
    const buffer = await zipBuffer([{ name: 'electron', body: '../escape', mode: 0o120777 }]);
    const manifest = manifestFor(buffer);
    const server = await fixtureServer(buffer);
    try {
      await assert.rejects(() => install(root, server, manifest), /extract|install|safely/i);
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('audio host policy grants only same-origin audio and filters environment', async () => {
  const config = parseConfiguration({ url: 'http://127.0.0.1:4567/#token=' + 'a'.repeat(32), profilePath: process.cwd() });
  assert.equal(config.origin, 'http://127.0.0.1:4567');
  assert.equal(allowMedia('media', { mediaTypes: ['audio'] }, config.origin, config.origin), true);
  assert.equal(allowMedia('media', { mediaTypes: ['video'] }, config.origin, config.origin), false);
  assert.equal(allowMedia('media', { mediaType: 'audio' }, config.origin, 'http://127.0.0.1:4568'), false);
  assert.equal(windowOptions('test').show, false);
  const filtered = audioEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require bad', DISPLAY: ':0' });
  assert.deepEqual(filtered, { PATH: '/bin', DISPLAY: ':0' });
});
