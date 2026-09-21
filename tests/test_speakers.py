"""Voice identity tests use deterministic encoders; real speech has a separate smoke script."""

import asyncio
import importlib.util
import json
import os
import tempfile
import time
import unittest
import uuid
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from server.speakers import (
    MAX_SECONDS, MODEL_ID, SAMPLE_RATE, ProfileStore, RecognitionDiarizer,
    SpeakerError, SpeakerService, TitaNetEncoder, clean_name, unit_vector,
)


def audio(seconds=1, frequency=170):
    return (0.1 * np.sin(np.arange(int(seconds * SAMPLE_RATE)) * 2 * np.pi * frequency / SAMPLE_RATE)).astype(np.float32)


def probabilities(speaker=1, frames=12):
    values = np.full((frames, 4), 0.01, dtype=np.float32)
    values[:, speaker - 1] = 0.99
    return values


class Tensor:
    def __init__(self, values):
        self.values = np.asarray(values)

    def __getitem__(self, key):
        return Tensor(self.values[key])

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.values


class StoreTests(unittest.TestCase):
    def test_atomic_private_file_contains_no_audio_or_session_id(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private" / "speakers.json"
            store = ProfileStore(path)
            profile_id = str(uuid.uuid4())
            store.save({profile_id: {"id": profile_id, "name": "Иван", "embedding": unit_vector([1, 2, 3])}})
            data = json.loads(path.read_text())
            self.assertEqual(data["model"], MODEL_ID)
            self.assertEqual(set(data["profiles"][0]), {"id", "name", "embedding"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(store.load()[profile_id]["name"], "Иван")
            self.assertEqual(len(list(path.parent.iterdir())), 1)

    def test_invalid_persistence_fails_closed_without_replacing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "speakers.json"
            for value in ("not json", '{"version":2}', json.dumps({"version": 1, "model": MODEL_ID,
                           "profiles": [{"id": str(uuid.uuid4()), "name": "John", "embedding": [float("nan"), 0]}]})):
                path.write_text(value)
                with self.assertRaises(SpeakerError):
                    ProfileStore(path).load()
                self.assertEqual(path.read_text(), value)

    def test_names_support_unicode_but_not_commands_or_markup(self):
        self.assertEqual(clean_name("  Jean-Luc   O’Neil  "), "Jean-Luc O’Neil")
        self.assertEqual(clean_name("Иван"), "Иван")
        for value in ("<John>", "John: hello", "--", "A" * 41, None, "John\x00", "123",
                      "John\nSmith", "John\tSmith", "Speaker", "-John"):
            with self.subTest(value=value), self.assertRaises(SpeakerError):
                clean_name(value)


class RecognitionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.services = []
        self.vector = np.array([1, 0, 0], dtype=np.float32)

    async def asyncTearDown(self):
        for service in self.services:
            await service.close()
        self.directory.cleanup()

    def service(self, **kwargs):
        service = SpeakerService(path=Path(self.directory.name) / "profiles.json",
                                 encoder_factory=kwargs.pop("encoder_factory", lambda: lambda _: self.vector), **kwargs)
        self.services.append(service)
        return service

    def session(self, service, **kwargs):
        messages = []

        async def send(payload):
            messages.append(payload)

        return service.session(send, **kwargs), messages

    async def wait_ready(self, service):
        async def wait():
            while service.status == "loading":
                await asyncio.sleep(0.005)
        await asyncio.wait_for(wait(), 2)

    async def feed(self, service, session, speaker=1, count=5):
        for _ in range(count):
            session.observe(audio(), probabilities(speaker))
        await service.queue.join()
        await asyncio.sleep(0)

    async def control(self, session, messages, **payload):
        await session._control({"request_id": "test", **payload})
        return [message for message in messages if message["type"] == "speaker_result"][-1]

    async def test_cross_session_order_never_reuses_numeric_identity_and_persists(self):
        service = self.service()
        first, first_messages = self.session(service)
        await self.wait_ready(service)
        await self.feed(service, first)
        result = await self.control(first, first_messages, type="speaker_enroll", speaker=1, name="John")
        self.assertTrue(result["ok"])
        self.assertEqual(first.state()["speakers"][0]["name"], "John")
        await first.close()

        # Reload from disk, and put John's voice in a different numeric slot.
        reloaded = self.service()
        second, _ = self.session(reloaded)
        await self.wait_ready(reloaded)
        await self.feed(reloaded, second, speaker=2)
        self.assertEqual(second.voices[2].profile_id, next(iter(service.profiles)))
        self.assertEqual(second.state()["speakers"][0]["name"], "John")
        self.vector = np.array([0, 1, 0], dtype=np.float32)
        await self.feed(reloaded, second, speaker=1)
        self.assertIsNone(second.voices[1].profile_id)

    async def test_ambiguous_and_unknown_voices_stay_anonymous(self):
        service = self.service()
        service.profiles = {
            "a": {"id": "a", "name": "John", "embedding": unit_vector([1, 0, 0])},
            "b": {"id": "b", "name": "Jane", "embedding": unit_vector([1, .05, 0])},
        }
        self.assertIsNone(service.match(unit_vector([1, 0, 0])))
        self.assertIsNone(service.match(unit_vector([0, 0, 1])))
        del service.profiles["b"]
        self.assertEqual(service.match(unit_vector([1, 0, 0])), "a")

    async def test_same_name_wrong_voice_rejected_and_correction_does_not_rename_other_profile(self):
        service = self.service()
        session, messages = self.session(service)
        await self.wait_ready(service)
        await self.feed(service, session)
        self.assertTrue((await self.control(session, messages, type="speaker_enroll", speaker=1, name="John"))["ok"])
        john_id = session.voices[1].profile_id
        self.vector = np.array([0, 1, 0], dtype=np.float32)
        await self.feed(service, session, speaker=2)
        self.assertFalse((await self.control(session, messages, type="speaker_enroll", speaker=2, name="john"))["ok"])
        self.assertEqual(len(service.profiles), 1)
        # Naming a voice never silently renames some previously matched identity.
        self.assertTrue((await self.control(session, messages, type="speaker_enroll", speaker=2, name="Jane"))["ok"])
        self.assertEqual(service.profiles[john_id]["name"], "John")
        self.assertEqual(len(service.profiles), 2)

    async def test_ambiguous_same_name_reenrollment_cannot_poison_existing_profile(self):
        service = self.service()
        session, messages = self.session(service)
        await self.wait_ready(service)
        await self.feed(service, session)
        await self.control(session, messages, type="speaker_enroll", speaker=1, name="John")
        john = next(iter(service.profiles.values()))
        original = john["embedding"].copy()
        # An explicitly corrected name creates its own profile. It must not
        # rename the previously matched person or poison that person's vector.
        await self.control(session, messages, type="speaker_enroll", speaker=1, name="Jane")
        self.assertEqual(len(service.profiles), 2)
        result = await self.control(session, messages, type="speaker_enroll", speaker=1, name="John")
        self.assertFalse(result["ok"])
        np.testing.assert_array_equal(service.profiles[john["id"]]["embedding"], original)

    async def test_rename_and_forget_broadcast_remove_names_from_other_sessions(self):
        service = self.service()
        first, first_messages = self.session(service)
        second, _ = self.session(service)
        await self.wait_ready(service)
        await self.feed(service, first)
        await self.feed(service, second, speaker=2)
        await self.control(first, first_messages, type="speaker_enroll", speaker=1, name="John")
        profile_id = first.voices[1].profile_id
        self.assertEqual(second.state()["speakers"][0]["name"], "John")
        await self.control(first, first_messages, type="speaker_rename", profile_id=profile_id, name="Иван")
        self.assertEqual(second.state()["speakers"][0]["name"], "Иван")
        await self.control(first, first_messages, type="speaker_forget", profile_id=profile_id)
        self.assertNotIn("name", second.state()["speakers"][0])
        self.assertIsNone(first.voices[1].explicit_id)
        self.assertEqual(ProfileStore(service.store.path).load(), {})

    async def test_overlap_low_confidence_silence_and_short_sample_cannot_enroll(self):
        service = self.service()
        session, messages = self.session(service)
        await self.wait_ready(service)
        overlap = probabilities()
        overlap[:, 1] = .8
        for _ in range(20):
            session.observe(audio(), overlap)
            session.observe(np.zeros(SAMPLE_RATE, dtype=np.float32), probabilities())
            session.observe(audio(), np.full((12, 4), .2))
        self.assertEqual(len(session.voices[1].audio), 0)
        await self.feed(service, session, count=3)
        result = await self.control(session, messages, type="speaker_enroll", speaker=1, name="John")
        self.assertFalse(result["ok"])
        self.assertFalse(service.profiles)

    async def test_frame_alignment_does_not_capture_the_adjacent_speaker(self):
        service = self.service()
        session, _ = self.session(service)
        await self.wait_ready(service)
        samples = np.r_[np.full(8000, .1), np.full(8000, -.1)].astype(np.float32)
        frames = np.concatenate((probabilities(1, 6), probabilities(2, 6)))
        session.observe(samples, frames)
        self.assertTrue(len(session.voices[1].audio) > 0)
        self.assertTrue(len(session.voices[2].audio) > 0)
        self.assertTrue(np.all(session.voices[1].audio > 0))
        self.assertTrue(np.all(session.voices[2].audio < 0))

    async def test_model_load_is_async_failure_is_nonfatal_and_no_controls_persist(self):
        def fail():
            time.sleep(.05)
            raise RuntimeError("model unavailable")
        service = self.service(encoder_factory=fail)
        session, messages = self.session(service)
        await asyncio.sleep(.01)
        self.assertEqual(service.status, "loading")
        await self.wait_ready(service)
        self.assertEqual(session.state()["status"], "unavailable")
        result = await self.control(session, messages, type="speaker_enroll", speaker=1, name="John")
        self.assertFalse(result["ok"])
        self.assertFalse(service.store.path.exists())

    async def test_disabled_session_does_not_load_models_or_expose_profiles(self):
        service = self.service()
        session, messages = self.session(service, enabled=False)
        session.observe(audio(8), probabilities())
        self.assertIsNone(service.task)
        self.assertEqual(session.state()["status"], "disabled")
        self.assertEqual(session.state()["profiles"], [])
        self.assertFalse((await self.control(session, messages, type="speaker_enroll", speaker=1, name="John"))["ok"])

    async def test_buffers_queue_and_controls_are_bounded_and_closed_work_is_discarded(self):
        service = self.service()
        session, _ = self.session(service)
        await self.wait_ready(service)
        # Observations are synchronous; inference remains queued during this burst.
        for _ in range(100):
            for speaker in range(1, 5):
                session.observe(audio(), probabilities(speaker))
        self.assertLessEqual(service.queue.qsize(), 4)
        self.assertTrue(all(len(voice.audio) <= MAX_SECONDS * SAMPLE_RATE for voice in session.voices.values()))
        self.assertTrue(session.control({"type": "speaker_enroll"}))
        for _ in range(3):
            self.assertTrue(session.control({"type": "speaker_enroll"}))
        self.assertFalse(session.control({"type": "speaker_enroll"}))
        await session.close()
        await service.queue.join()
        self.assertEqual(session.voices, {})
        self.assertNotIn(session, service.sessions)

    async def test_unmatched_retry_is_faster_without_lowering_initial_minimum_or_queue_bounds(self):
        service = self.service()
        session, _ = self.session(service)
        await self.wait_ready(service)
        for _ in range(4):
            session.observe(audio(), probabilities())
        voice = session.voices[1]
        self.assertLess(len(voice.audio), 4 * SAMPLE_RATE)
        self.assertEqual(service.queue.qsize(), 0)
        session.observe(audio(), probabilities())
        self.assertEqual(service.queue.qsize(), 1)
        self.assertTrue(voice.pending)
        first_sample = voice.scheduled_samples
        # More audio while the worker is pending cannot enqueue another job.
        session.observe(audio(.5), probabilities())
        self.assertEqual(service.queue.qsize(), 1)
        await service.queue.join()
        self.assertIsNone(voice.profile_id)
        self.assertEqual(voice.scheduled_samples, first_sample)
        session.observe(audio(), probabilities())
        self.assertEqual(service.queue.qsize(), 1)
        self.assertLess(voice.scheduled_samples - first_sample, 2 * SAMPLE_RATE)
        await service.queue.join()

        # Once confidently named, rechecks retain the cheaper four-second cadence.
        profile_id = str(uuid.uuid4())
        service.profiles[profile_id] = {"id": profile_id, "name": "John", "embedding": self.vector.copy()}
        session.rematch()
        self.assertEqual(voice.profile_id, profile_id)
        for _ in range(4):
            session.observe(audio(), probabilities())
        self.assertEqual(service.queue.qsize(), 0)
        session.observe(audio(), probabilities())
        self.assertEqual(service.queue.qsize(), 1)
        await service.queue.join()

    async def test_corrupt_store_does_not_load_model_or_get_overwritten(self):
        service = self.service()
        service.store.path.write_text("corrupt")
        session, messages = self.session(service)
        await self.wait_ready(service)
        self.assertEqual(service.status, "unavailable")
        self.assertFalse((await self.control(session, messages, type="speaker_forget", profile_id="bad"))["ok"])
        self.assertEqual(service.store.path.read_text(), "corrupt")


class AlignmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_capture_consumed_audio_across_silence_offset_and_residual_buffer(self):
        observed = []
        old_audio, new_audio = audio(.4, 150), audio(.6, 320)
        expected = np.concatenate((old_audio, new_audio))

        class Diarizer:
            chunk_duration_seconds = 1
            sample_rate = SAMPLE_RATE
            global_time_offset = 20.0
            _len_prediction = 12
            buffer_audio = np.concatenate((expected, audio(.2, 450)))
            total_preds = Tensor(probabilities()[None, :, :])

            async def diarize(self):
                self.buffer_audio = self.buffer_audio[SAMPLE_RATE:]
                return [SimpleNamespace(start=20, end=20.92, speaker=0)]

        wrapped = RecognitionDiarizer(Diarizer(), SimpleNamespace(observe=lambda pcm, probs: observed.append((pcm, probs))))
        result = await wrapped.diarize()
        self.assertEqual(result[0].start, 20)
        np.testing.assert_array_equal(observed[0][0], expected)
        np.testing.assert_array_equal(observed[0][1], probabilities())
        self.assertEqual(len(wrapped.buffer_audio), int(.2 * SAMPLE_RATE))

    async def test_partial_audio_is_not_reprocessed_and_tap_failure_preserves_captions(self):
        class Diarizer:
            chunk_duration_seconds = 1
            sample_rate = SAMPLE_RATE
            buffer_audio = audio(.1)

            async def diarize(self):
                return ["caption"]

        def fail(*_):
            raise AssertionError("Must not receive partial block")
        wrapped = RecognitionDiarizer(Diarizer(), SimpleNamespace(observe=fail))
        self.assertEqual(await wrapped.diarize(), ["caption"])


class QualityTests(unittest.TestCase):
    def test_independent_speech_gate_rejects_noise_before_embedding(self):
        encoder = object.__new__(TitaNetEncoder)
        encoder.torch = SimpleNamespace(inference_mode=nullcontext)
        encoder._speech_fraction = lambda _: 0.0
        encoder.model = SimpleNamespace(infer_segment=lambda _: self.fail("Noise must not reach the voice model"))
        rng = np.random.default_rng(42)
        for sample in (np.zeros(4 * SAMPLE_RATE, dtype=np.float32),
                       rng.normal(0, .1, 4 * SAMPLE_RATE).astype(np.float32)):
            with self.assertRaises(SpeakerError):
                encoder(sample)

    def test_conflicting_half_embeddings_are_not_enrolled(self):
        encoder = object.__new__(TitaNetEncoder)
        encoder.torch = SimpleNamespace(inference_mode=nullcontext)
        encoder._speech_fraction = lambda _: 1.0
        vectors = iter(([1, 0, 0], [0, 1, 0]))
        encoder.model = SimpleNamespace(infer_segment=lambda _: (Tensor([next(vectors)]), None))
        with self.assertRaisesRegex(SpeakerError, "inconsistent"):
            encoder(audio(4))


@unittest.skipUnless(importlib.util.find_spec("whisperlivekit"), "WhisperLiveKit runtime dependencies are not installed")
class WebSocketTests(unittest.TestCase):
    def test_recognition_load_failure_and_bad_controls_do_not_interrupt_binary_captions(self):
        from fastapi.testclient import TestClient
        from server.app import create_app
        from whisperlivekit.config import WhisperLiveKitConfig

        class Processor:
            def __init__(self, **_):
                self.queue = asyncio.Queue()
                self.diarization = SimpleNamespace()

            async def create_tasks(self):
                async def results():
                    while True:
                        chunk = await self.queue.get()
                        if not chunk:
                            return
                        yield SimpleNamespace(to_dict=lambda: {"lines": [{"speaker": 1, "text": "Captions continue"}]})
                return results()

            async def process_audio(self, chunk):
                await self.queue.put(chunk)

            async def cleanup(self):
                pass

        def fail():
            raise RuntimeError("test model missing")

        with tempfile.TemporaryDirectory() as directory:
            service = SpeakerService(path=Path(directory) / "speakers.json", encoder_factory=fail)
            config = WhisperLiveKitConfig(backend="faster-whisper", backend_policy="localagreement",
                                          beams=1, pcm_input=True, diarization=True, diarization_backend="sortformer")
            with patch("server.app.SpeakerService", return_value=service), \
                    patch("server.app.TranscriptionEngine", return_value=SimpleNamespace()), \
                    patch("server.app.supported_languages", return_value=["en"]), \
                    patch("server.app.session_engine", return_value=SimpleNamespace()), \
                    patch("server.app.AudioProcessor", Processor):
                with TestClient(create_app(config)) as client:
                    with client.websocket_connect("/asr?remember_speakers=1") as websocket:
                        config_message = websocket.receive_json()
                        self.assertEqual(config_message["type"], "config")
                        self.assertTrue(config_message["speaker_recognition"])
                        while True:
                            state = websocket.receive_json()
                            if state.get("status") == "unavailable":
                                break
                        websocket.send_text("bad json")
                        self.assertFalse(websocket.receive_json()["ok"])
                        websocket.send_json({"type": "speaker_enroll", "speaker": 1, "name": "John", "request_id": "one"})
                        self.assertFalse(websocket.receive_json()["ok"])
                        websocket.send_bytes(b"\x01\x00" * 1600)
                        self.assertEqual(websocket.receive_json()["lines"][0]["text"], "Captions continue")
                        websocket.send_bytes(b"")
                        self.assertEqual(websocket.receive_json()["type"], "ready_to_stop")


if __name__ == "__main__":
    unittest.main()
