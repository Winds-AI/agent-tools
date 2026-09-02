#!/usr/bin/env python3
"""voice-note: browser PCM -> local ASR -> append-only transcript lines."""

import argparse
import json
import os
import platform
import secrets
import shutil
import signal
import subprocess
import sys
import time
from array import array
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SAMPLE_RATE = 16000
CHUNK_SAMPLES = SAMPLE_RATE * 10
MAX_CHUNK_BYTES = CHUNK_SAMPLES * 4


def voice_home():
    return Path(
        os.environ.get("VOICE_NOTE_HOME", str(Path.home() / ".voice-note"))
    ).expanduser()


def paths():
    root = voice_home()
    return {
        "root": root,
        "config": root / "config.json",
        "state": root / "state.json",
        "cursor": root / "cursor.json",
        "stop": root / "stop-requested",
        "browser_stopped": root / "browser-stopped",
    }


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def unlink(path):
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def configured():
    location = paths()["config"]
    if not location.exists():
        raise SystemExit("voice-note setup is missing; follow SETUP.md")
    value = read_json(location)
    if not Path(value["python"]).exists() or not Path(value["model"]).exists():
        raise SystemExit("voice-note setup is incomplete; rerun scripts/setup.py")
    return value


def ensure_runtime():
    try:
        import transcribe_cpp  # noqa: F401

        return
    except ImportError:
        pass
    python = configured()["python"]
    os.execv(python, [python] + sys.argv)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def timestamp(seconds):
    whole = int(seconds)
    hours, remainder = divmod(whole, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def append_transcript(path, start_sample, text):
    with path.open("a", encoding="utf-8") as output:
        output.write(f"[{timestamp(start_sample / SAMPLE_RATE)}] {text.strip()}\n")


PAGE = r"""<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>voice-note</title>
<style>
body{font-family:system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;color:#222}
button{font:inherit;padding:.65rem 1rem;border:1px solid #999;border-radius:.5rem;background:#fff}
#status{margin:1.5rem 0}.error{color:#a00}#retry{display:none}
</style>
<h1>voice-note</h1>
<p id="status">Requesting microphone access…</p>
<button id="mute" disabled>Mute</button>
<button id="retry">Enable microphone</button>
<script>
const TOKEN=__TOKEN__;
const RATE=16000, WINDOW=RATE*10;
let context, stream, worklet, muted=false, accepting=false, finishing=false;
let parts=[], buffered=0, nextSample=0, sequence=0, failures=0;
let uploadChain=Promise.resolve();
const status=document.querySelector('#status'), mute=document.querySelector('#mute'), retry=document.querySelector('#retry');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function show(message,error=false){status.textContent=message;status.className=error?'error':'';}
function take(count){
  const output=new Float32Array(count);let offset=0;
  while(offset<count){
    const head=parts[0], size=Math.min(head.length,count-offset);
    output.set(head.subarray(0,size),offset);offset+=size;
    if(size===head.length) parts.shift(); else parts[0]=head.subarray(size);
  }
  buffered-=count;return output;
}
function queueUpload(samples){
  const start=nextSample, number=sequence++;
  nextSample+=samples.length;
  uploadChain=uploadChain.then(async()=>{
    const response=await fetch(`/chunk?token=${TOKEN}&sequence=${number}&start_sample=${start}`,{
      method:'POST',headers:{'Content-Type':'application/octet-stream'},body:samples.buffer
    });
    if(!response.ok) throw new Error(await response.text());
  }).catch(async error=>{
    finishing=true;accepting=false;mute.disabled=true;
    stream?.getTracks().forEach(track=>track.stop());
    show('Transcription stopped: '+error.message,true);
    await fetch(`/browser-stopped?token=${TOKEN}`,{method:'POST'}).catch(()=>{});
  });
}
function accept(samples){
  if(!accepting||muted) return;
  parts.push(samples);buffered+=samples.length;
  while(buffered>=WINDOW) queueUpload(take(WINDOW));
}
async function start(){
  retry.style.display='none';
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    context=new AudioContext({sampleRate:RATE,latencyHint:'interactive'});
    if(context.sampleRate!==RATE) throw new Error(`This browser opened audio at ${context.sampleRate} Hz; voice-note v1 requires 16000 Hz.`);
    await context.audioWorklet.addModule(`/audio-worklet.js?token=${TOKEN}`);
    const source=context.createMediaStreamSource(stream);
    worklet=new AudioWorkletNode(context,'voice-note-capture',{numberOfInputs:1,numberOfOutputs:0});
    worklet.port.onmessage=event=>accept(event.data);
    source.connect(worklet);accepting=true;mute.disabled=false;
    show('Listening. Audio stays on this machine.');
  }catch(error){
    show('Microphone unavailable: '+error.message,true);retry.style.display='inline-block';
  }
}
async function finish(){
  if(finishing) return;finishing=true;
  if(worklet){worklet.port.postMessage('flush');await sleep(100);}
  accepting=false;
  if(buffered) queueUpload(take(buffered));
  await uploadChain;
  stream?.getTracks().forEach(track=>track.stop());
  if(context) await context.close();
  await fetch(`/browser-stopped?token=${TOKEN}`,{method:'POST'}).catch(()=>{});
  mute.disabled=true;show('Session ended.');
}
mute.onclick=()=>{
  muted=!muted;mute.textContent=muted?'Unmute':'Mute';show(muted?'Muted. The session remains open.':'Listening. Audio stays on this machine.');
};
retry.onclick=start;
setInterval(async()=>{
  try{
    const response=await fetch(`/control?token=${TOKEN}`);failures=0;
    if((await response.json()).stop) finish();
  }catch{if(++failures>=3){stream?.getTracks().forEach(track=>track.stop());show('Local server stopped.');}}
},500);
start();
</script>"""


class Handler(BaseHTTPRequestHandler):
    server_version = "voice-note/0.1"

    def log_message(self, *_):
        pass

    def request_parts(self):
        parsed = urlparse(self.path)
        return parsed.path, parse_qs(parsed.query)

    def authorized(self, query):
        return query.get("token", [""])[0] == self.server.token

    def send_bytes(self, status, body, content_type="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route, query = self.request_parts()
        if not self.authorized(query):
            self.send_bytes(403, "forbidden")
            return
        if route == "/":
            page = PAGE.replace("__TOKEN__", json.dumps(self.server.token))
            self.send_bytes(200, page, "text/html; charset=utf-8")
        elif route == "/audio-worklet.js":
            self.send_bytes(200, self.server.worklet, "text/javascript; charset=utf-8")
        elif route == "/control":
            body = json.dumps({"stop": paths()["stop"].exists()})
            self.send_bytes(200, body, "application/json")
        else:
            self.send_bytes(404, "not found")

    def do_POST(self):
        route, query = self.request_parts()
        if not self.authorized(query):
            self.send_bytes(403, "forbidden")
            return
        if route == "/browser-stopped":
            paths()["browser_stopped"].touch()
            self.send_bytes(204, b"")
            return
        if route != "/chunk":
            self.send_bytes(404, "not found")
            return
        try:
            sequence = int(query["sequence"][0])
            start_sample = int(query["start_sample"][0])
            length = int(self.headers.get("Content-Length", "0"))
            if (
                sequence != self.server.sequence
                or start_sample != self.server.next_sample
            ):
                raise ValueError("audio sequence mismatch")
            if length <= 0 or length > MAX_CHUNK_BYTES or length % 4:
                raise ValueError("invalid PCM chunk size")
            body = self.rfile.read(length)
            samples = array("f")
            samples.frombytes(body)
            if sys.byteorder != "little":
                samples.byteswap()
            result = self.server.session.run(samples)
            if result.text.strip():
                append_transcript(self.server.transcript, start_sample, result.text)
            self.server.sequence += 1
            self.server.next_sample += len(samples)
            self.send_bytes(204, b"")
        except (KeyError, ValueError) as error:
            self.send_bytes(409, str(error))
        except Exception as error:  # noqa: BLE001 - surface native runtime failures
            self.send_bytes(500, f"transcription failed: {error}")


def serve(args):
    import transcribe_cpp

    config = configured()
    worklet = (Path(__file__).parent / "audio-worklet.js").read_text(encoding="utf-8")
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    server.token = args.token
    server.transcript = Path(args.transcript).resolve()
    server.worklet = worklet
    server.sequence = 0
    server.next_sample = 0
    with (
        transcribe_cpp.Model(config["model"], backend="auto") as model,
        model.session() as session,
    ):
        server.session = session
        write_json(
            paths()["state"],
            {
                "pid": os.getpid(),
                "port": server.server_address[1],
                "token": server.token,
                "transcript": str(server.transcript),
                "profile": config["profile"],
                "device": repr(model.device),
            },
        )
        server.serve_forever()


def open_browser(url):
    try:
        if sys.platform == "darwin":
            subprocess.Popen(
                ["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        elif os.name == "nt":
            os.startfile(url)  # type: ignore[attr-defined]
        elif "microsoft" in platform.release().lower() and shutil.which("cmd.exe"):
            subprocess.Popen(
                ["cmd.exe", "/c", "start", "", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        elif shutil.which("xdg-open"):
            subprocess.Popen(
                ["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
    except OSError:
        pass


def cmd_start(args):
    location = paths()
    location["root"].mkdir(parents=True, exist_ok=True)
    if location["state"].exists():
        state = read_json(location["state"])
        if alive(state["pid"]):
            print(f"already running: {state['transcript']}")
            return 1
        unlink(location["state"])
    unlink(location["stop"])
    unlink(location["browser_stopped"])

    transcript = Path(args.transcript).expanduser().resolve()
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.touch()
    write_json(
        location["cursor"],
        {"transcript": str(transcript), "committed": 0, "pending": 0},
    )

    token = secrets.token_urlsafe(24)
    subprocess.Popen(
        [
            sys.executable,
            __file__,
            "_serve",
            "--port",
            str(args.port),
            "--token",
            token,
            "--transcript",
            str(transcript),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=(os.name != "nt"),
        creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
    )
    deadline = time.time() + 60
    while time.time() < deadline:
        if location["state"].exists():
            state = read_json(location["state"])
            url = f"http://localhost:{state['port']}/?token={state['token']}"
            print(f"URL: {url}")
            print(f"transcript: {state['transcript']}")
            print(f"profile: {state['profile']}")
            if not args.no_open:
                open_browser(url)
            return 0
        time.sleep(0.1)
    print("server failed to start; rerun status or setup", file=sys.stderr)
    return 1


def cmd_stop(_args):
    location = paths()
    if not location["state"].exists():
        print("not running")
        return 0
    state = read_json(location["state"])
    location["stop"].touch()
    deadline = time.time() + 5
    while time.time() < deadline and alive(state["pid"]):
        if location["browser_stopped"].exists():
            break
        time.sleep(0.1)
    try:
        os.kill(state["pid"], signal.SIGTERM)
    except ProcessLookupError:
        pass
    unlink(location["state"])
    unlink(location["stop"])
    unlink(location["browser_stopped"])
    print(f"stopped: {state['transcript']}")
    return 0


def cmd_status(_args):
    config = configured()
    print(f"configured: {config['profile']}")
    print(f"model: {config['model']}")
    print(
        "backends: "
        + ", ".join(f"{item['kind']}:{item['name']}" for item in config["backends"])
    )
    state_path = paths()["state"]
    if state_path.exists():
        state = read_json(state_path)
        if alive(state["pid"]):
            print(f"running: {state['transcript']}")
            print(f"device: {state['device']}")
            return 0
    print("not running")
    return 0


def cmd_poll(args):
    cursor_path = paths()["cursor"]
    if not cursor_path.exists():
        print("no session cursor; start a session first", file=sys.stderr)
        return 1
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        cursor = read_json(cursor_path)
        transcript = Path(cursor["transcript"])
        lines = (
            transcript.read_text(encoding="utf-8").splitlines()
            if transcript.exists()
            else []
        )
        committed = int(cursor.get("committed", 0))
        if len(lines) > committed:
            cursor["pending"] = len(lines)
            write_json(cursor_path, cursor)
            for line in lines[committed:]:
                print(line)
            return 0
        time.sleep(0.25)
    return 1


def cmd_commit(_args):
    cursor_path = paths()["cursor"]
    if not cursor_path.exists():
        print("no session cursor", file=sys.stderr)
        return 1
    cursor = read_json(cursor_path)
    cursor["committed"] = int(cursor.get("pending", cursor.get("committed", 0)))
    write_json(cursor_path, cursor)
    return 0


def main():
    parser = argparse.ArgumentParser(prog="vn", description="local voice notes")
    parser.add_argument(
        "-p",
        "--poll",
        action="store_true",
        help="wait for uncommitted transcript lines",
    )
    parser.add_argument(
        "-c",
        "--commit",
        action="store_true",
        help="commit the last returned transcript delta",
    )
    parser.add_argument(
        "-t", "--timeout", type=float, default=15, help="poll timeout in seconds"
    )
    sub = parser.add_subparsers(dest="command")

    start = sub.add_parser(
        "start", help="start browser capture and local transcription"
    )
    start.add_argument("--transcript", default="transcript.txt")
    start.add_argument("--port", type=int, default=0)
    start.add_argument("--no-open", action="store_true")
    start.set_defaults(handler=cmd_start)
    sub.add_parser("stop", help="flush and stop the session").set_defaults(
        handler=cmd_stop
    )
    sub.add_parser("status", help="show configuration and session state").set_defaults(
        handler=cmd_status
    )

    internal = sub.add_parser("_serve", help=argparse.SUPPRESS)
    internal.add_argument("--port", type=int, required=True)
    internal.add_argument("--token", required=True)
    internal.add_argument("--transcript", required=True)
    internal.set_defaults(handler=lambda args: serve(args))

    args = parser.parse_args()
    if args.poll and args.commit:
        parser.error("--poll and --commit are mutually exclusive")
    if args.poll:
        return cmd_poll(args)
    if args.commit:
        return cmd_commit(args)
    if not hasattr(args, "handler"):
        parser.print_help()
        return 1
    if args.command in ("start", "_serve"):
        ensure_runtime()
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
