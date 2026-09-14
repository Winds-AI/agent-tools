import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCodexAuth } from "../src/auth.mjs";

async function fixture(dir, name, value) {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("prefers a fresh Pi credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-voice-auth-"));
  try {
    const piAuthPath = await fixture(dir, "pi.json", {
      "openai-codex": { type: "oauth", access: "access-pi", expires: 2_000, accountId: "acct-pi" },
    });
    const codexAuthPath = await fixture(dir, "codex.json", {
      tokens: { access_token: "access-codex", account_id: "acct-codex" },
    });
    const auth = await getCodexAuth({ piAuthPath, codexAuthPath, now: 1_000 });
    assert.deepEqual(auth, { token: "access-pi", accountId: "acct-pi", source: "pi", expires: 2_000 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("falls back to the Codex auth file when the Pi credential expired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-voice-auth-"));
  try {
    const piAuthPath = await fixture(dir, "pi.json", {
      "openai-codex": { access: "access-pi", expires: 500, accountId: "acct-pi" },
    });
    const codexAuthPath = await fixture(dir, "codex.json", {
      tokens: { access_token: "access-codex", account_id: "acct-codex" },
    });
    const auth = await getCodexAuth({ piAuthPath, codexAuthPath, now: 1_000 });
    assert.equal(auth.token, "access-codex");
    assert.equal(auth.source, "codex");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("accepts the account_id spelling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-voice-auth-"));
  try {
    const piAuthPath = await fixture(dir, "pi.json", {
      "openai-codex": { access: "access-pi", account_id: "acct-snake" },
    });
    const auth = await getCodexAuth({ piAuthPath, codexAuthPath: join(dir, "missing.json") });
    assert.equal(auth.accountId, "acct-snake");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explains how to sign in when nothing is available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-voice-auth-"));
  try {
    await assert.rejects(
      getCodexAuth({ piAuthPath: join(dir, "missing-pi.json"), codexAuthPath: join(dir, "missing-codex.json") }),
      /codex login/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
