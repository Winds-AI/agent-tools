#!/usr/bin/env python3
"""Local speech detection for pi-voice.

JSON lines in, JSON lines out. Input is 24 kHz s16le mono PCM in exact 20 ms
frames; the extension feeds the same microphone audio that the model hears.

Emitted events:
  {"type": "activity", "speech": true|false}      edge-triggered speech state
  {"type": "level", "vad": 0-1, "db": <dBFS>}     telemetry for tuning

This process never touches the network and never stores audio.
"""
import base64
from fractions import Fraction
import json
import math
from pathlib import Path
import sys

import av
import numpy as np
import onnxruntime as ort

FRAME = 480  # 20 ms at 24 kHz

# --- Wake sensitivity -------------------------------------------------------
# Tune these when the session wakes on sniffs, coughs, breathing or other
# non-speech sounds instead of speech.
#
# START_THRESHOLD   speech probability (0-1) a 32 ms window must reach.
# START_WINDOWS     consecutive windows above it required to open the session:
#                   2 = 64 ms, 8 = 256 ms (default), 12 = 384 ms.
# MIN_LEVEL_DB      frames quieter than this (dBFS) never count as speech.
# RELEASE_THRESHOLD how far the probability must fall to release speech.
# RELEASE_WINDOWS   consecutive released windows that end a speech run
#                   (10 = 320 ms).
START_THRESHOLD = 0.5
START_WINDOWS = 8
MIN_LEVEL_DB = -50.0
RELEASE_THRESHOLD = 0.35
RELEASE_WINDOWS = 10

# Telemetry cadence: one level event every 100 ms.
LEVEL_EVERY = 5
# ---------------------------------------------------------------------------


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
        self.probability = 0.0
        self.speech = False

    def feed(self, pcm, level_db):
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
            self.probability = float(probability.ravel()[0])
            audible = level_db >= MIN_LEVEL_DB
            self.positive = self.positive + 1 if (self.probability >= START_THRESHOLD and audible) else 0
            self.negative = self.negative + 1 if self.probability < RELEASE_THRESHOLD else 0
            if self.positive >= START_WINDOWS:
                self.speech = True
            elif self.negative >= RELEASE_WINDOWS:
                self.speech = False
        return self.speech


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def main():
    detector = Detector(Path(__file__).parent / "silero_vad.onnx")
    emit({"type": "ready"})
    speech = False
    frames = 0
    for line in sys.stdin:
        request = json.loads(line)
        if request.get("type") != "input":
            continue
        pcm = base64.b64decode(request["audio"], validate=True)
        if len(pcm) != FRAME * 2:
            raise ValueError("PCM input must contain exactly 20 ms")
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        level_db = 20.0 * math.log10(float(np.sqrt(np.mean(samples * samples))) + 1e-9)
        next_speech = detector.feed(pcm, level_db)
        if next_speech != speech:
            speech = next_speech
            emit({"type": "activity", "speech": speech})
        frames += 1
        if frames % LEVEL_EVERY == 0:
            emit({"type": "level", "vad": round(detector.probability, 3), "db": round(level_db, 1)})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # stdout is the protocol; never print audio, transcripts, or environment data.
        emit({"type": "error", "message": "Local speech detection failed"})
        sys.exit(1)
