import base64
import importlib.util
from pathlib import Path
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("worker", ROOT / "audio/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FakeDetector:
    speech = False

    def feed(self, pcm):
        return self.speech


def tone(frame, hz=440):
    samples = np.arange(frame * 480, (frame + 1) * 480)
    return (np.sin(samples * 2 * np.pi * hz / 24000) * 10000).astype("<i2").tobytes()


class AudioTests(unittest.TestCase):
    def test_onset_keeps_preroll_and_connection_backlog(self):
        detector = FakeDetector()
        p = worker.Processor(detector)
        for i in range(30):
            self.assertFalse(p.input(tone(i))["wake"])
        self.assertEqual(len(p.queue), 15)
        detector.speech = True
        self.assertTrue(p.input(tone(30))["wake"])
        for i in range(31, 130):
            self.assertFalse(p.input(tone(i))["wake"])
        self.assertEqual(list(p.queue), [tone(i) for i in range(15, 130)])

    def test_sleep_preserves_onset_at_connection_close_boundary(self):
        detector = FakeDetector()
        p = worker.Processor(detector)
        detector.speech = True
        for i in range(100):
            p.input(tone(i))
        p.start()
        for i in range(100, 350):
            p.input(tone(i))
            p.pull()
        p.sleep()
        self.assertEqual(list(p.queue), [tone(i) for i in range(335, 350)])
        self.assertTrue(p.input(tone(350))["wake"])
        self.assertEqual(p.queue[0], tone(335))

    def test_catchup_switch_preserves_pitch_and_reaches_live_without_gaps(self):
        p = worker.Processor(FakeDetector())
        p.mode = "buffering"
        for i in range(100):
            p.input(tone(i))
        p.start()
        output = bytearray()
        rates = []
        for i in range(100, 500):
            p.input(tone(i))
            response = p.pull()
            rates.append(response["rate"])
            frame = base64.b64decode(response["audio"])
            self.assertEqual(len(frame), 960)
            output.extend(frame)
        self.assertIn(1.5, rates)
        self.assertEqual(rates[-1], 1)
        self.assertLess(len(p.queue), 10)
        samples = np.frombuffer(output, dtype="<i2").astype(float)
        # A sample-rate trick would shift 440 Hz to 660 Hz; atempo must not.
        for section in [samples[:24000], samples[-24000:]]:
            spectrum = abs(np.fft.rfft(section * np.hanning(len(section))))
            peak = np.fft.rfftfreq(len(section), 1 / 24000)[np.argmax(spectrum)]
            self.assertAlmostEqual(peak, 440, delta=2)
            self.assertGreater(np.sqrt(np.mean(section ** 2)), 6000)

    def test_long_startup_fails_without_silently_discarding_speech(self):
        p = worker.Processor(FakeDetector())
        p.mode = "buffering"
        with self.assertRaises(BufferError):
            for _ in range(751):
                p.input(bytes(960))

    def test_tempo_recovers_a_scheduling_stall_without_recreating_the_filter(self):
        p = worker.Processor(FakeDetector())
        p.mode = "buffering"
        for i in range(100):
            p.input(tone(i))
        p.start()
        original = p.tempo
        for i in range(100, 400):
            p.input(tone(i))
            p.pull()
        self.assertEqual(p.tempo.rate, 1)
        for i in range(400, 450):
            p.input(tone(i))
        self.assertEqual(p.pull()["rate"], 1.5)
        for i in range(450, 650):
            p.input(tone(i))
            p.pull()
        self.assertEqual(p.tempo.rate, 1)
        self.assertIs(p.tempo, original)

    def test_real_detector_stays_asleep_on_silence(self):
        p = worker.Processor(worker.Detector(ROOT / "audio/silero_vad.onnx"))
        for _ in range(100):
            self.assertEqual(p.input(bytes(960)),
                             {"type": "activity", "speech": False, "wake": False})
        self.assertEqual(len(p.queue), 15)


if __name__ == "__main__":
    unittest.main()
