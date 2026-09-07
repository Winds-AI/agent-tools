#!/usr/bin/env python3
"""Install the pinned local runtime and one explicit voice-note model profile."""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import urllib.request
from pathlib import Path

RUNTIME = "transcribe-cpp==0.2.0"
PROFILES = {
    "apple-silicon": {
        "model": "whisper-large-v3-turbo-Q8_0.gguf",
        "url": "https://huggingface.co/handy-computer/whisper-large-v3-turbo-gguf/resolve/main/whisper-large-v3-turbo-Q8_0.gguf",
        "sha256": "b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183",
        "bytes": 886381760,
    },
    "portable": {
        "model": "whisper-small.en-Q8_0.gguf",
        "url": "https://huggingface.co/handy-computer/whisper-small.en-gguf/resolve/main/whisper-small.en-Q8_0.gguf",
        "sha256": "9614e6b7fda2d26018e4f268aece8ca25a83296ea0b534169a585b740bfd71ef",
        "bytes": 269674144,
    },
}


def voice_home():
    return Path(
        os.environ.get("VOICE_NOTE_HOME", str(Path.home() / ".voice-note"))
    ).expanduser()


def venv_python(root):
    if os.name == "nt":
        return root / ".venv" / "Scripts" / "python.exe"
    return root / ".venv" / "bin" / "python"


def automatic_profile():
    if platform.system() == "Darwin" and platform.machine().lower() in (
        "arm64",
        "aarch64",
    ):
        return "apple-silicon"
    return "portable"


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(profile, destination):
    expected = profile["sha256"]
    if destination.exists() and file_hash(destination) == expected:
        print(f"model already verified: {destination}")
        return

    partial = destination.with_suffix(destination.suffix + ".part")
    if partial.exists():
        partial.unlink()
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {profile['bytes'] / 1_000_000:.0f} MB: {profile['model']}")
    with (
        urllib.request.urlopen(profile["url"]) as response,
        partial.open("wb") as output,
    ):
        received = 0
        while True:
            block = response.read(8 * 1024 * 1024)
            if not block:
                break
            output.write(block)
            received += len(block)
            print(f"  {received * 100 // profile['bytes']:3d}%", end="\r", flush=True)
    print("  100%")
    actual = file_hash(partial)
    if actual != expected:
        partial.unlink()
        raise SystemExit(f"model hash mismatch: expected {expected}, received {actual}")
    partial.replace(destination)


def inspect_runtime(python):
    code = (
        "import json, transcribe_cpp; "
        "print(json.dumps([{'kind':d.kind,'name':d.name,'type':d.device_type} "
        "for d in transcribe_cpp.backends()]))"
    )
    result = subprocess.run(
        [str(python), "-c", code], check=True, capture_output=True, text=True
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(
        description="configure the local voice-note runtime"
    )
    parser.add_argument(
        "--profile", choices=("auto", "apple-silicon", "portable"), default="auto"
    )
    args = parser.parse_args()

    selected = automatic_profile() if args.profile == "auto" else args.profile
    profile = PROFILES[selected]
    root = voice_home()
    python = venv_python(root)
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("uv is required; follow SETUP.md before retrying")

    root.mkdir(parents=True, exist_ok=True)
    if not python.exists():
        subprocess.run(
            [uv, "venv", "--python", "3.12", str(root / ".venv")], check=True
        )
    subprocess.run([uv, "pip", "install", "--python", str(python), RUNTIME], check=True)

    model = root / "models" / profile["model"]
    download(profile, model)
    backends = inspect_runtime(python)
    if not any(item["kind"] == "cpu" for item in backends):
        raise SystemExit("transcribe.cpp loaded without a CPU fallback")
    if selected == "apple-silicon" and not any(
        item["kind"] == "metal" for item in backends
    ):
        raise SystemExit(
            "apple-silicon profile selected, but the Metal backend is unavailable"
        )

    write_json(
        root / "config.json",
        {
            "profile": selected,
            "runtime": RUNTIME,
            "python": str(python.absolute()),
            "model": str(model.resolve()),
            "backends": backends,
        },
    )
    print(f"configured: {selected}")
    print(f"model: {model}")
    print(
        "backends: " + ", ".join(f"{item['kind']}:{item['name']}" for item in backends)
    )


if __name__ == "__main__":
    main()
