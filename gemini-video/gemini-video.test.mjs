import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeVideo, fitVideo } from './gemini-video.mjs';

const completed = {
  status: 'completed',
  output: [
    { type: 'reasoning', encrypted_content: 'navigation' },
    { type: 'message', content: [{ type: 'output_text', text: '00:02: A tab opens.' }] },
  ],
};
const json = (value, status = 200) => Response.json(value, { status });

async function fixture(t, name = 'clip.mp4', bytes = 'fixture bytes') {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-video-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

test('sends the local video inline with agentic processing and returns only the answer', async t => {
  const path = await fixture(t);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'google/gemini-3.8-flash');
    const [video, text] = body.input[0].content;
    assert.equal(video.type, 'input_video');
    assert.equal(video.processing, 'agentic');
    assert.equal(video.video_url, `data:video/mp4;base64,${Buffer.from('fixture bytes').toString('base64')}`);
    assert.deepEqual(text, { type: 'input_text', text: 'Which tab opens?' });
    return json(completed);
  });
  const result = await analyzeVideo(path, 'Which tab opens?', 'test-key');
  assert.equal(result.text, '00:02: A tab opens.');
  assert.ok(result.response.output.some(item => item.type === 'reasoning'));
});

test('a reply without an answer is retried with static processing', async t => {
  const path = await fixture(t);
  t.mock.method(process.stderr, 'write', () => true);
  const modes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    modes.push(JSON.parse(options.body).input[0].content[0].processing);
    return modes.length === 1 ? new Response('\n \n') : json(completed);
  });
  const result = await analyzeVideo(path, 'Question', 'test-key');
  assert.equal(result.text, '00:02: A tab opens.');
  assert.equal(result.processing, 'static');
  assert.deepEqual(modes, ['agentic', 'static']);
});

test('rate limits are retried in the same mode', async t => {
  const path = await fixture(t);
  const modes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    modes.push(JSON.parse(options.body).input[0].content[0].processing);
    return modes.length === 1 ? json({ error: { message: 'slow down' } }, 429) : json(completed);
  });
  const result = await analyzeVideo(path, 'Question', 'test-key');
  assert.equal(result.processing, 'agentic');
  assert.deepEqual(modes, ['agentic', 'agentic']);
});

test('client errors fail at once and never leak the key', async t => {
  const path = await fixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return json({ error: { message: 'bad key test-key' } }, 400); });
  await assert.rejects(analyzeVideo(path, 'Question', 'test-key'), error => {
    assert.ok(!error.message.includes('test-key'));
    return /OpenRouter \(400\)/.test(error.message);
  });
  assert.equal(calls, 1);
});

test('links and unknown formats are rejected before any request', async t => {
  const path = await fixture(t, 'clip.txt');
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no request expected'));
  await assert.rejects(analyzeVideo('https://youtu.be/example', 'Question', 'test-key'), /local video file/);
  await assert.rejects(analyzeVideo(path, 'Question', 'test-key'), /Unsupported video extension/);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('large videos are re-encoded to fit the size limit', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async t => {
  const path = await fixture(t, 'big.mp4', '');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=20',
    '-f', 'lavfi', '-i', 'sine=duration=20', '-c:v', 'libx264', '-crf', '10', '-c:a', 'aac', '-shortest', path]);
  assert.equal(made.status, 0, String(made.stderr));
  const limit = 400_000;
  assert.ok((await stat(path)).size > limit);
  const fitted = await fitVideo(path, limit);
  t.after(fitted.cleanup);
  assert.equal(fitted.mime, 'video/mp4');
  assert.ok((await stat(fitted.path)).size <= limit);
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
  await writeFile(join(home, '.config/gemini-video/openrouter-api-key'), 'file-key\n', { mode: 0o600 });
  const video = join(home, 'clip.mp4');
  await writeFile(video, 'fixture bytes');
  for (const envKey of ['environment-key', '']) {
    const expected = envKey || 'file-key';
    const mock = `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://openrouter.ai/api/v1/responses');
        assert.equal(options.headers.Authorization, 'Bearer ' + ${JSON.stringify(expected)});
        return Response.json(${JSON.stringify(completed)});
      };
    `;
    const run = spawnSync(process.execPath, [
      '--import', 'data:text/javascript,' + encodeURIComponent(mock),
      fileURLToPath(new URL('./gemini-video.mjs', import.meta.url)),
      video, 'Which tab opens?',
    ], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, OPENROUTER_API_KEY: envKey } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '00:02: A tab opens.\n');
    assert.equal(run.stderr, '');
  }
});
