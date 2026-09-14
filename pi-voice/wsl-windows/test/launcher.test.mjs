import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
test("Bash launcher adds only voice extension, preserves literal arguments and normal Pi", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-voice-launcher-"));
  try {
    await writeFile(
      join(dir, "pi"),
      '#!/usr/bin/env python3\nimport json,sys,os\nprint(json.dumps({"args":sys.argv[1:],"cwd":os.getcwd()}))\n',
      { mode: 0o755 },
    );
    const script =
      'source "$1"\npi -V --continue "@a file.txt"\npi --version\npi -- -V';
    const out = execFileSync(
      "bash",
      ["-c", script, "bash", resolve("pi-voice.bash")],
      {
        env: {
          ...process.env,
          PATH: dir + ":" + process.env.PATH,
          PI_VOICE_API_KEY: "",
        },
        encoding: "utf8",
      },
    );
    const rows = out
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.deepEqual(rows[0].args, [
      "-e",
      resolve("index.ts"),
      "--continue",
      "@a file.txt",
    ]);
    assert.equal(rows[0].cwd, process.cwd());
    assert.deepEqual(rows[1].args, ["--version"]);
    assert.deepEqual(rows[2].args, ["--", "-V"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
