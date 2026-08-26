#!/usr/bin/env python3
import argparse, io, json, os, re, shutil, signal, subprocess, sys, time

SHARE = os.path.expanduser("~/.local/share/vn/sessions")
STATE_DIR = os.path.expanduser("~/.local/state/vn")
STATE = os.path.join(STATE_DIR, "current.json")
MODEL = "mlx-community/whisper-large-v3-turbo"
CHUNK_SECONDS = 10  # seconds of audio per transcript line


# ------------------------------------------------------------------ bootstrap

def ensure_mlx():
    # Re-exec under a python that has mlx_whisper, if this one lacks it.
    try:
        import mlx_whisper  # noqa: F401
        return
    except ImportError:
        pass
    cand = (os.environ.get("VN_MLX_PYTHON")
            or os.path.expanduser("~/.agents/skills/watch/.venv/bin/python"))
    if os.path.exists(cand):
        os.execv(cand, [cand] + sys.argv)
    print("error: mlx_whisper unavailable (needs the watch-skill venv python)", file=sys.stderr)
    sys.exit(1)


# ------------------------------------------------------------------ small utils

def ts_str(secs):
    secs = int(secs)
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def mb(path):
    return os.path.getsize(path) / 1e6 if os.path.exists(path) else 0


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return None


def save_state(st):
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(STATE, "w") as f:
        json.dump(st, f)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def require_state():
    st = load_state()
    if st is None:
        print("error: not running (run vn start first)", file=sys.stderr)
        sys.exit(1)
    return st


def print_devices():
    # Parse ffmpeg's avfoundation dump; listing prints at info level -> -hide_banner.
    r = subprocess.run(["ffmpeg", "-hide_banner", "-f", "avfoundation",
                        "-list_devices", "true", "-i", ""],
                       capture_output=True, text=True)
    in_audio, found = False, False
    for ln in r.stderr.splitlines():
        if "audio devices" in ln:
            in_audio = True
            continue
        if "video devices" in ln:
            in_audio = False
            continue
        if in_audio:
            m = re.search(r"\[(\d+)\]\s*(.+)$", ln)
            if m:
                found = True
                print(f"{m.group(1)}  {m.group(2)}")
    if not found:
        print("no audio input devices found", file=sys.stderr)


# ------------------------------------------------------------------ pipeline

def wav_frame(pcm):
    # Wrap raw s16le mono 16kHz PCM in a minimal 44-byte WAV container.
    return (b"RIFF" + (36 + len(pcm)).to_bytes(4, "little") + b"WAVEfmt " +
            (16).to_bytes(4, "little") + (1).to_bytes(2, "little") +
            (1).to_bytes(2, "little") + (16000).to_bytes(4, "little") +
            (32000).to_bytes(4, "little") + (2).to_bytes(2, "little") +
            (16).to_bytes(2, "little") + b"data" +
            len(pcm).to_bytes(4, "little") + pcm)


def transcribe_wav(wav_bytes):
    # Local transcription; model loads from HF cache, no network.
    import numpy as np, wave, mlx_whisper
    with wave.open(io.BytesIO(wav_bytes)) as w:
        raw = w.readframes(w.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    res = mlx_whisper.transcribe(audio, path_or_hf_repo=MODEL, temperature=0.0,
                                 condition_on_previous_text=False, verbose=None)
    return res["text"].strip()


def append_line(path, stamp, text):
    with open(path, "a") as f:
        f.write(f"[{ts_str(stamp)}] {text}\n")


# ------------------------------------------------------------------ capture worker

def run_capture(args):
    # Detached child of start: ffmpeg PCM -> voice.wav (live) -> transcribe -> append.
    # Mute is a flag, not a signal: muted bytes are dropped here, so they never reach
    # the wav, the transcript, or memory beyond one 4KB read. Transcript stamps count
    # captured seconds, so they stay aligned with the wav/flac playhead across mutes.
    ensure_mlx()
    d = args.dir
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-f", "avfoundation", "-i", f":{args.device}",
         "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
        stdout=subprocess.PIPE, stderr=open(os.path.join(d, "ffmpeg.log"), "w"))
    save_state({"pid": os.getpid(), "ffmpeg_pid": proc.pid, "session": d,
                "transcript": args.transcript,
                "device": args.device, "muted": False, "cursor": 0,
                "chunk": CHUNK_SECONDS, "start": time.time()})

    wav_path = os.path.join(d, "voice.wav")
    wav = open(wav_path, "wb")
    # Real 44-byte PCM header template, sizes patched in finally.
    wav.write(b"RIFF" + b"\x00\x00\x00\x00" + b"WAVEfmt " + (16).to_bytes(4, "little") +
              (1).to_bytes(2, "little") + (1).to_bytes(2, "little") +
              (16000).to_bytes(4, "little") + (32000).to_bytes(4, "little") +
              (2).to_bytes(2, "little") + (16).to_bytes(2, "little") +
              b"data" + b"\x00\x00\x00\x00")
    wav.flush()
    data_size, written = 0, 0
    chunk_bytes = CHUNK_SECONDS * 16000 * 2
    buf, stamp = b"", 0
    try:
        while True:
            data = proc.stdout.read(4096)
            if not data:
                break  # ffmpeg died; see ffmpeg.log
            st = load_state()
            if st and st.get("muted"):
                buf = b""  # drop any partial buffered speech at the mute boundary
                continue
            buf += data
            while len(buf) >= chunk_bytes:
                pcm, buf = buf[:chunk_bytes], buf[chunk_bytes:]
                wav.write(pcm)
                data_size += len(pcm)
                written += 1
                wav.flush()
                try:
                    text = transcribe_wav(wav_frame(pcm)).strip()
                    if any(c.isalnum() for c in text):  # drop "..." silence hallucinations
                        append_line(args.transcript, stamp, text)
                except Exception:
                    pass
                stamp += CHUNK_SECONDS
    finally:
        try:
            wav.flush()
            wav.seek(4)
            wav.write((36 + data_size).to_bytes(4, "little"))
            wav.seek(40)
            wav.write(data_size.to_bytes(4, "little"))
            wav.close()
        except Exception:
            pass
        proc.terminate()


# ------------------------------------------------------------------ commands

def cmd_devices(args):
    print_devices()
    return 0


def cmd_start(args):
    # Require an explicit device; create this session's dir; spawn detached worker.
    if shutil.which("ffmpeg") is None:
        print("error: ffmpeg not found on PATH", file=sys.stderr)
        return 1
    if args.device is None:
        print("usage: vn start <device>   (pick the index from the list below)\n", file=sys.stderr)
        print_devices()
        return 1

    st = load_state()
    if st and alive(st.get("pid", -1)):
        print(f"error: already running (pid {st['pid']})", file=sys.stderr)
        return 1

    sid = time.strftime("%Y%m%d-%H%M%S")
    sd = os.path.join(SHARE, sid)
    n = 2
    while os.path.exists(sd):
        sd = os.path.join(SHARE, f"{sid}-{n}")
        n += 1
    os.makedirs(sd)
    transcript = os.path.join(sd, "transcript.txt")
    open(transcript, "w").close()
    with open(os.path.join(sd, "meta.json"), "w") as f:
        json.dump({"id": os.path.basename(sd), "start": time.time(),
                   "device": args.device, "chunk": CHUNK_SECONDS,
                   "model": MODEL, "cwd": os.getcwd()}, f, indent=2)

    subprocess.Popen(
        [sys.executable, os.path.realpath(__file__), "_capture",
         "--dir", sd, "--transcript", transcript, "--device", args.device],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True)

    for _ in range(200):  # wait for the worker to publish state
        st = load_state()
        if st:
            break
        time.sleep(0.05)
    if not st or not alive(st["pid"]):
        print(f"error: capture failed to start (see {sd}/ffmpeg.log)", file=sys.stderr)
        return 1
    print(f"recording device {args.device} ({CHUNK_SECONDS}s chunks)")
    print(f"session: {sd}")
    return 0


def cmd_stop(args):
    # Kill worker + ffmpeg; compress voice.wav -> voice.flac; keep the session dir.
    st = require_state()
    for pid in (st["ffmpeg_pid"], st["pid"]):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    os.remove(STATE)

    sd = st["session"]
    wav, flac = os.path.join(sd, "voice.wav"), os.path.join(sd, "voice.flac")
    if os.path.exists(wav) and os.path.getsize(wav) > 44:
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav,
                            "-c:a", "flac", flac], capture_output=True, text=True)
        if r.returncode == 0 and os.path.exists(flac) and os.path.getsize(flac) > 0:
            os.remove(wav)
        else:
            print(f"note: flac conversion failed ({(r.stderr or '').strip().splitlines()[-1] if r.stderr else 'unknown'}); kept voice.wav")
    kept = "voice.flac" if os.path.exists(flac) else "voice.wav"
    print(f"stopped · {kept} {mb(os.path.join(sd, kept)):.1f}MB · {sd}")
    return 0


def cmd_mute(on):
    def fn(args):
        st = require_state()
        st["muted"] = bool(on)
        save_state(st)
        print("muted" if on else "unmuted")
        return 0
    return fn


def cmd_poll(args):
    # Instant check-once: print ONLY lines past the cursor, advance it, exit.
    # 0 = new lines printed; 1 = nothing new / not running. Never blocks.
    st = load_state()
    if st is None:
        print("error: not running (run vn start first)", file=sys.stderr)
        return 1
    lines = []
    if os.path.exists(st["transcript"]):
        with open(st["transcript"]) as f:
            lines = f.read().splitlines()
    if len(lines) > int(st.get("cursor", 0)):
        for line in lines[int(st.get("cursor", 0)):]:
            print(line)
        st["cursor"] = len(lines)
        save_state(st)
        return 0
    return 1


# ------------------------------------------------------------------ main

def main():
    p = argparse.ArgumentParser(prog="vn",
                                description="voice session: mic -> transcript + audio")
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("devices", help="list audio input devices").set_defaults(fn=cmd_devices)

    ps = sub.add_parser("start", help="start capture (requires device index from vn devices)")
    ps.add_argument("device", nargs="?", default=None)
    ps.set_defaults(fn=cmd_start)

    sub.add_parser("stop", help="stop session, compress audio, keep session dir").set_defaults(fn=cmd_stop)
    sub.add_parser("mute", help="pause capture (bytes discarded)").set_defaults(fn=cmd_mute(True))
    sub.add_parser("unmute", help="resume capture").set_defaults(fn=cmd_mute(False))
    sub.add_parser("poll", help="print transcript lines since last poll").set_defaults(fn=cmd_poll)

    pc = sub.add_parser("_capture", help=argparse.SUPPRESS)
    pc.add_argument("--dir", required=True)
    pc.add_argument("--transcript", required=True)
    pc.add_argument("--device", default="0")
    pc.set_defaults(fn=run_capture)

    args = p.parse_args()
    if not getattr(args, "fn", None):
        p.print_help()
        sys.exit(1)
    if args.cmd == "_capture":
        ensure_mlx()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    main()
