# Setup guide

Read this file only when the runtime reports that setup is missing or the user
asks to reconfigure the transcription profile.

## 1. Detect the current environment

Identify the OS and architecture before changing anything:

- macOS Apple Silicon: `apple-silicon` profile, Whisper large-v3-turbo Q8_0
  (approximately 886 MB), Metal selected automatically.
- Windows x64, Linux x64, or WSL2: `portable` profile, Whisper small.en Q8_0
  (approximately 270 MB). The runtime may use Vulkan automatically when the
  installed driver supports it; CPU remains the fallback.
- Intel macOS: use the `portable` profile.

Windows + Pi in WSL2 is supported: run setup and the runtime inside WSL. The
microphone remains in the Windows browser, which sends raw audio to the WSL
localhost server. Do not configure WSL microphone devices.

Other architectures are outside the tested v1 scope. Explain that plainly and
ask the user whether to try the `portable` profile.

## 2. Confirm the first-run download

Tell the user which profile was selected and its approximate model-download
size. Get confirmation before installing `uv` or downloading the model.

## 3. Ensure `uv` exists

Check `uv --version`. If it is missing, use the official installation method
for the current OS from <https://docs.astral.sh/uv/getting-started/installation/>
after the user confirms.

## 4. Run the deterministic setup

Resolve the skill directory, then run:

```bash
uv run --no-project --python 3.12 ~/.agents/skills/voice-note/scripts/setup.py --profile auto
```

On native Windows PowerShell, use:

```powershell
uv run --no-project --python 3.12 "$env:USERPROFILE\.agents\skills\voice-note\scripts\setup.py" --profile auto
```

Use `--profile apple-silicon` or `--profile portable` only when the user
explicitly chooses an override. The setup is idempotent. It creates an isolated
runtime and model cache under `~/.voice-note/`, verifies the model hash, imports
the native runtime, and writes the selected configuration.

## 5. Verify

Run:

```bash
python3 ~/.agents/skills/voice-note/scripts/vn.py status
```

Use the PowerShell command form from `SKILL.md` on native Windows.

`configured:` must show the selected profile, model, and available inference
device. Do not start a voice session until this succeeds.
