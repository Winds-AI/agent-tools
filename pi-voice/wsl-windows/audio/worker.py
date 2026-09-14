#!/usr/bin/env python3
"""Local VAD and pitch-preserving catch-up. JSON lines in/out; PCM is 24 kHz s16le mono."""
import base64
from collections import deque
from fractions import Fraction
import json
from pathlib import Path
import sys

import av
import numpy as np
import onnxruntime as ort

FRAME = 480  # 20 ms at 24 kHz
PRE_ROLL = 15  # 300 ms, including detector confirmation delay
MAX_QUEUE = 750  # 15 seconds: fail visibly rather than lose an utterance


def audio_frame(pcm, position):
    frame = av.AudioFrame.from_ndarray(
        np.frombuffer(pcm, dtype="<i2").reshape(1, -1), format="s16", layout="mono")
    frame.sample_rate = 24000
    frame.pts = position
    frame.time_base = Fraction(1, 24000)
    return frame


class Detector:
    def __init__(self, model):
        options = ort.SessionOptions()
        options.inter_op_num_threads = options.intra_op_num_threads = 1
        self.model = ort.InferenceSession(str(model), sess_options=options,
                                         providers=["CPUExecutionProvider"])
        self.resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
        self.state = np.zeros((2, 1, 128), np.float32)
        self.context = np.zeros((1, 64), np.float32)
        self.pending = np.zeros(0, np.float32)
        self.position = self.positive = self.negative = 0
        self.speech = False

    def feed(self, pcm):
        for frame in self.resampler.resample(audio_frame(pcm, self.position)):
            self.pending = np.concatenate(
                (self.pending, frame.to_ndarray().ravel().astype(np.float32) / 32768))
        self.position += FRAME
        while len(self.pending) >= 512:
            chunk, self.pending = self.pending[:512], self.pending[512:]
            inputs = np.concatenate((self.context, chunk.reshape(1, -1)), axis=1)
            probability, self.state = self.model.run(None, {
                "input": inputs, "state": self.state, "sr": np.array(16000, np.int64)})
            self.context = inputs[:, -64:]
            p = float(probability.ravel()[0])
            self.positive = self.positive + 1 if p >= 0.5 else 0
            self.negative = self.negative + 1 if p < 0.35 else 0
            if self.positive >= 2:
                self.speech = True
            elif self.negative >= 10:  # 320 ms release hysteresis, not the idle timeout
                self.speech = False
        return self.speech


class Tempo:
    def __init__(self):
        self.graph = av.filter.Graph()
        self.source = self.graph.add_abuffer(
            sample_rate=24000, format="s16", layout="mono", time_base=Fraction(1, 24000))
        self.effect = self.graph.add("atempo", "1.5")
        self.sink = self.graph.add("abuffersink")
        self.source.link_to(self.effect)
        self.effect.link_to(self.sink)
        self.graph.configure()
        self.position = 0
        self.rate = 1.5

    def feed(self, pcm, rate):
        if rate != self.rate:
            # Change the running filter: never cut, flush or recreate it at the join.
            self.effect.process_command("tempo", str(rate))
            self.rate = rate
        self.source.push(audio_frame(pcm, self.position))
        self.position += len(pcm) // 2
        output = bytearray()
        while True:
            try:
                output.extend(self.sink.pull().to_ndarray().astype("<i2", copy=False).tobytes())
            except av.error.BlockingIOError:
                return output


class Processor:
    def __init__(self, detector):
        self.detector = detector
        self.queue = deque()
        self.recent = deque(maxlen=PRE_ROLL)
        self.output = bytearray()
        self.mode = "armed"
        self.tempo = None
        self.catching_up = False

    def input(self, pcm):
        if len(pcm) != FRAME * 2:
            raise ValueError("PCM input must contain exactly 20 ms")
        speech = self.detector.feed(pcm)
        self.queue.append(pcm)
        self.recent.append(pcm)
        wake = self.mode == "armed" and speech
        if wake:
            self.mode = "buffering"
        elif self.mode == "armed":
            while len(self.queue) > PRE_ROLL:
                self.queue.popleft()
        if len(self.queue) > MAX_QUEUE:
            raise BufferError("Audio startup exceeded the 15-second buffer")
        return {"type": "activity", "speech": speech, "wake": wake}

    def start(self):
        self.mode = "streaming"
        self.tempo = Tempo()
        self.catching_up = True
        self.output.clear()

    def sleep(self):
        self.mode = "armed"
        self.queue = deque(self.recent)
        self.output.clear()
        self.tempo = None

    def pull(self):
        if self.mode != "streaming":
            return {"type": "audio", "audio": "", "backlog_ms": 0, "rate": 1}
        if len(self.queue) > 25:
            # Recover from local scheduling stalls using the same bounded catch-up.
            self.catching_up = True
        while len(self.output) < FRAME * 2 and self.queue:
            if self.catching_up and len(self.queue) <= 8:
                self.catching_up = False
            rate = 1.5 if self.catching_up else 1
            self.output.extend(self.tempo.feed(self.queue.popleft(), rate))
        # The last partial output stays queued; no padding, dropping, or burst upload.
        pcm = b""
        if len(self.output) >= FRAME * 2:
            pcm = bytes(self.output[:FRAME * 2])
            del self.output[:FRAME * 2]
        return {"type": "audio", "audio": base64.b64encode(pcm).decode("ascii"),
                "backlog_ms": len(self.queue) * 20 + len(self.output) / 48,
                "rate": self.tempo.rate}


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def main():
    processor = Processor(Detector(Path(__file__).parent / "silero_vad.onnx"))
    emit({"type": "ready"})
    for line in sys.stdin:
        request = json.loads(line)
        kind = request["type"]
        if kind == "input":
            emit(processor.input(base64.b64decode(request["audio"], validate=True)))
        elif kind == "start":
            processor.start()
        elif kind == "sleep":
            processor.sleep()
        elif kind == "pull":
            emit({**processor.pull(), "stream": request["stream"]})
        else:
            raise ValueError("Unknown audio command")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # stdout is the protocol; do not print audio, transcripts, or environment data.
        emit({"type": "error", "message": "Local audio processing failed"})
        sys.exit(1)
