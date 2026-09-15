import base64
import importlib.util
import json
import os
import select
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON = os.path.join(ROOT, ".venv", "bin", "python")
WORKER = os.path.join(ROOT, "audio", "worker.py")

_spec = importlib.util.spec_from_file_location("worker", WORKER)
worker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(worker)

SILENCE_FRAME = base64.b64encode(b"\x00" * 960).decode()


def frame(pcm):
    return base64.b64encode(pcm).decode()


class WorkerTest(unittest.TestCase):
    def setUp(self):
        if not os.path.exists(PYTHON):
            self.skipTest("run bin/setup-audio first")
        self.process = subprocess.Popen(
            [PYTHON, "-u", WORKER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        ready = json.loads(self.process.stdout.readline())
        self.assertEqual(ready["type"], "ready")

    def tearDown(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.terminate()
            self.process.wait(timeout=5)

    def send(self, audio):
        self.process.stdin.write(json.dumps({"type": "input", "audio": audio}) + "\n")
        self.process.stdin.flush()

    def events(self, timeout=5.0):
        collected = []
        deadline = timeout
        while deadline > 0:
            ready, _, _ = select.select([self.process.stdout], [], [], 0.25)
            if not ready:
                deadline -= 0.25
                continue
            line = self.process.stdout.readline()
            if not line:
                break
            collected.append(json.loads(line))
        return collected

    def test_silence_never_reports_speech(self):
        for _ in range(25):
            self.send(SILENCE_FRAME)
        events = self.events(timeout=1.0)
        self.assertEqual([e for e in events if e.get("type") == "activity"], [])
        levels = [e for e in events if e.get("type") == "level"]
        self.assertTrue(levels, "expected level telemetry for tuning")
        self.assertIn("vad", levels[0])
        self.assertIn("db", levels[0])

    def test_tuned_wake_constants_are_in_force(self):
        self.assertEqual(worker.START_THRESHOLD, 0.5)
        self.assertEqual(worker.START_WINDOWS, 8)  # 256 ms of continuous speech
        self.assertEqual(worker.MIN_LEVEL_DB, -50.0)
        self.assertEqual(worker.RELEASE_THRESHOLD, 0.35)
        self.assertEqual(worker.RELEASE_WINDOWS, 10)

    @unittest.skipUnless(shutil.which("say") and shutil.which("afconvert"), "macOS voices required")
    def test_speech_frames_trigger_activity(self):
        import av
        import numpy as np

        with tempfile.TemporaryDirectory() as directory:
            aiff = os.path.join(directory, "speech.aiff")
            wav = os.path.join(directory, "speech.wav")
            subprocess.run(
                ["say", "-o", aiff, "Testing one two three four five six seven"],
                check=True,
            )
            subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@24000", "-c", "1", aiff, wav], check=True)
            container = av.open(wav)
            resampler = av.AudioResampler(format="s16", layout="mono", rate=24000)
            pcm = bytearray()
            for decoded in container.decode(audio=0):
                for resampled in resampler.resample(decoded):
                    pcm.extend(resampled.to_ndarray().tobytes())
        self.assertGreater(len(pcm), 24000)
        for offset in range(0, len(pcm) - 959, 960):
            self.send(frame(bytes(pcm[offset : offset + 960])))
        for _ in range(20):  # 400 ms of silence releases the VAD hysteresis
            self.send(SILENCE_FRAME)
        events = self.events(timeout=8.0)
        speech = [event for event in events if event.get("type") == "activity"]
        self.assertTrue(any(event["speech"] for event in speech), "expected a speech start")
        self.assertTrue(any(not event["speech"] for event in speech), "expected a speech release")


if __name__ == "__main__":
    unittest.main()
