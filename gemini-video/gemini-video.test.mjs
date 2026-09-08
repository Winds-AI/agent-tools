import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeVideo } from './gemini-video.mjs';

const completed = {
  status: 'completed',
  steps: [
    { type: 'thought', content: [{ type: 'text', text: 'private reasoning' }] },
    { type: 'processing_call' }, { type: 'processing_result' },
    { type: 'model_output', content: [{ type: 'text', text: '00:02: A tab opens.' }] },
  ],
};
const json = (value, status = 200) => Response.json(value, { status });

test('YouTube is passed directly; only final answer text is returned', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gemini-3.8-flash');
    assert.equal(body.input[0].processing, 'agentic');
    assert.equal(body.input[1].text, 'Which tab opens?');
    assert.equal(body.store, false);
    return json(completed);
  });
  const result = await analyzeVideo('https://youtu.be/example', 'Which tab opens?', 'test-key');
  assert.equal(result.text, '00:02: A tab opens.');
  assert.ok(result.interaction.steps.some(s => s.type === 'processing_result'));
});

for (const scenario of ['quota error', 'processing failure', 'success']) {
  test(`local upload is removed after ${scenario}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'gemini-video-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'clip.mp4');
    await writeFile(path, 'fixture bytes');
    let deleted = false;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (options.method === 'DELETE') {
        assert.ok(url.endsWith('/files/test-upload'));
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/upload/v1beta/files')) {
        return new Response(null, { headers: { 'x-goog-upload-url': 'https://upload.example/session' } });
      }
      if (url === 'https://upload.example/session') {
        const chunks = [];
        for await (const chunk of options.body) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString(), 'fixture bytes');
        return json({ file: { name: 'files/test-upload', uri: 'https://files.example/video', state: scenario === 'processing failure' ? 'FAILED' : 'ACTIVE' } });
      }
      assert.ok(url.endsWith('/interactions'));
      return scenario === 'quota error' ? json({ error: { message: 'test-key quota exceeded' } }, 429) : json(completed);
    });
    if (scenario === 'success') {
      assert.equal((await analyzeVideo(path, 'What happens?', 'test-key')).text, '00:02: A tab opens.');
    } else {
      await assert.rejects(analyzeVideo(path, 'What happens?', 'test-key'), error => {
        assert.ok(!error.message.includes('test-key'));
        return scenario === 'quota error' ? /429/.test(error.message) : /processing failed/.test(error.message);
      });
    }
    assert.equal(deleted, true);
  });
}

test('incomplete output is an error rather than a successful partial answer', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({ ...completed, status: 'incomplete' }));
  await assert.rejects(analyzeVideo('https://youtu.be/example', 'Question', 'test-key'), /did not complete/);
});

test('CLI misuse writes no answer to stdout and fails', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./gemini-video.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /Usage:/);
});

test('a closed output pipe exits quietly', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./gemini-video.mjs', import.meta.url)), '--help']);
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code));
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdout.destroy();
  assert.equal(await closed, 1);
  assert.equal(stderr, '');
});

test('CLI uses the current environment key before the user-local key file', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gemini-video-auth-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.config/gemini-video'), { recursive: true });
  await writeFile(join(home, '.config/gemini-video/api-key'), 'file-key\n', { mode: 0o600 });
  for (const envKey of ['environment-key', '']) {
    const expected = envKey || 'file-key';
    const mock = `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
        assert.equal(options.headers['x-goog-api-key'], ${JSON.stringify(expected)});
        return Response.json(${JSON.stringify(completed)});
      };
    `;
    const run = spawnSync(process.execPath, [
      '--import', 'data:text/javascript,' + encodeURIComponent(mock),
      fileURLToPath(new URL('./gemini-video.mjs', import.meta.url)),
      'https://youtu.be/example', 'Which tab opens?',
    ], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, GEMINI_API_KEY: envKey } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '00:02: A tab opens.\n');
    assert.equal(run.stderr, '');
  }
});
