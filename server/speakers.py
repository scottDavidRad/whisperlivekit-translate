"""Local, opt-in voice profiles; numeric diarization IDs never leave a session.

Only normalized TitaNet embeddings are persisted. Audio stays in bounded memory.
Model loading and inference use one dedicated worker, independent of live ASR.
"""

import asyncio
import json
import logging
import os
import tempfile
import unicodedata
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)
SAMPLE_RATE = 16000
MIN_SECONDS = 4.0
MAX_SECONDS = 12.0
MAX_PROFILES = 100
MODEL_ID = "nvidia/speakerverification_en_titanet_large"


class SpeakerError(ValueError):
    """A safe, actionable error that may be displayed to the user."""


def clean_name(value):
    if not isinstance(value, str):
        raise SpeakerError("Use a person's name, between 1 and 40 characters.")
    if any(unicodedata.category(c).startswith("C") for c in value):
        raise SpeakerError("Names cannot contain line breaks or control characters.")
    name = " ".join(part for part in unicodedata.normalize("NFC", value).strip().split(" ") if part)
    if not 1 <= len(name) <= 40 or not any(unicodedata.category(c).startswith("L") for c in name):
        raise SpeakerError("Use a person's name, between 1 and 40 characters.")
    if any(not (unicodedata.category(c)[0] in "LM" or c in " '-’") for c in name):
        raise SpeakerError("Names may contain letters, spaces, apostrophes, and hyphens.")
    if unicodedata.category(name[0])[0] not in "LM" or name.casefold() in {"speaker", "person", "pending", "unknown speaker"}:
        raise SpeakerError("Use the person's name rather than an anonymous speaker label.")
    return name


def unit_vector(value):
    vector = np.asarray(value, dtype=np.float32)
    if vector.ndim != 1 or not 2 <= len(vector) <= 4096 or not np.isfinite(vector).all():
        raise SpeakerError("Invalid voice profile.")
    norm = np.linalg.norm(vector)
    if norm < 1e-6:
        raise SpeakerError("No usable voice was found. Speak clearly for a little longer.")
    return vector / norm


class ProfileStore:
    def __init__(self, path):
        self.path = Path(path).expanduser()

    def load(self):
        if not self.path.exists():
            return {}
        if self.path.stat().st_size > 2_000_000:
            raise SpeakerError("The saved voice-profile file is invalid; it has not been changed.")
        try:
            data = json.loads(self.path.read_text())
            if data.get("version") != 1 or data.get("model") != MODEL_ID:
                raise ValueError("Unsupported profile format")
            rows = data["profiles"]
            if not isinstance(rows, list) or len(rows) > MAX_PROFILES:
                raise ValueError("Invalid profile count")
            profiles = {}
            names = set()
            dimensions = set()
            for row in rows:
                profile_id = str(uuid.UUID(row["id"]))
                name = clean_name(row["name"])
                vector = unit_vector(row["embedding"])
                if profile_id in profiles or name.casefold() in names:
                    raise ValueError("Duplicate profile")
                profiles[profile_id] = {"id": profile_id, "name": name, "embedding": vector}
                names.add(name.casefold())
                dimensions.add(len(vector))
            if len(dimensions) > 1:
                raise ValueError("Inconsistent embeddings")
            return profiles
        except Exception as error:
            raise SpeakerError("The saved voice-profile file is invalid; it has not been changed.") from error

    def save(self, profiles):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        data = {"version": 1, "model": MODEL_ID, "profiles": [
            {"id": row["id"], "name": row["name"], "embedding": row["embedding"].tolist()}
            for row in profiles.values()
        ]}
        descriptor, temporary = tempfile.mkstemp(prefix=".speakers-", dir=self.path.parent)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w") as file:
                json.dump(data, file, ensure_ascii=False, separators=(",", ":"))
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def basic_audio_quality(audio):
    if not np.isfinite(audio).all() or not len(audio):
        return False
    rms = float(np.sqrt(np.mean(audio * audio)))
    if rms < 0.002 or np.mean(np.abs(audio) >= 0.995) > 0.02:
        return False
    return True


class TitaNetEncoder:
    """Use already-installed NeMo and bundled Silero; never write a WAV file."""

    def __init__(self):
        import torch
        import whisperlivekit
        from nemo.collections.asr.models import EncDecSpeakerLabelModel

        self.torch = torch
        model_path = os.environ.get("SPEAKER_MODEL_PATH", "")
        if model_path:
            self.model = EncDecSpeakerLabelModel.restore_from(model_path, map_location="cpu")
        else:
            self.model = EncDecSpeakerLabelModel.from_pretrained("titanet_large", map_location="cpu")
        self.model.eval().to("cpu")
        vad_path = Path(whisperlivekit.__file__).parent / "silero_vad_models" / "silero_vad.jit"
        self.vad = torch.jit.load(str(vad_path), map_location="cpu").eval()

    def _speech_fraction(self, audio):
        self.vad.reset_states()
        decisions = []
        for start in range(0, len(audio) - 511, 512):
            value = self.vad(self.torch.from_numpy(audio[start:start + 512]), SAMPLE_RATE)
            decisions.append(float(value.item()) >= 0.5)
        return sum(decisions) / max(1, len(decisions))

    def __call__(self, audio):
        audio = np.asarray(audio, dtype=np.float32)
        if len(audio) < int(MIN_SECONDS * SAMPLE_RATE) or not basic_audio_quality(audio):
            raise SpeakerError("More clear speech is needed. Avoid silence, noise, and overlapping voices.")
        vectors = []
        with self.torch.inference_mode():
            # Independent halves reject a contaminated diarization slot. Silero
            # is separate from WLK's stateful VAD and lives only on this worker.
            for half in np.array_split(audio, 2):
                if self._speech_fraction(half) < 0.65:
                    raise SpeakerError("More clear speech is needed. Avoid silence, noise, and overlapping voices.")
                embedding, _ = self.model.infer_segment(half)
                vectors.append(unit_vector(embedding.detach().cpu().numpy().reshape(-1)))
        if float(vectors[0] @ vectors[1]) < 0.60:
            raise SpeakerError("The voice sample is inconsistent. Let this person speak alone for longer.")
        return unit_vector(vectors[0] + vectors[1])


@dataclass
class Voice:
    audio: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.float32))
    total_samples: int = 0
    scheduled_samples: int = 0
    embedding: np.ndarray | None = None
    profile_id: str | None = None
    explicit_id: str | None = None
    pending: bool = False
    error: str | None = None


class SpeakerService:
    def __init__(self, *, path=None, encoder_factory=TitaNetEncoder, threshold=None, margin=None):
        self.store = ProfileStore(path or os.environ.get(
            "SPEAKER_PROFILES_PATH", "~/.local/share/whisperlivekit-translate/speakers.json"))
        self.threshold = float(threshold if threshold is not None else os.environ.get("SPEAKER_MATCH_THRESHOLD", "0.75"))
        self.margin = float(margin if margin is not None else os.environ.get("SPEAKER_MATCH_MARGIN", "0.10"))
        if not 0.5 <= self.threshold <= 1 or not 0.05 <= self.margin <= 0.5:
            raise ValueError("Speaker matching thresholds are outside the supported range.")
        self.encoder_factory = encoder_factory
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="speaker-identity")
        self.profiles = {}
        self.sessions = set()
        self.queue = asyncio.Queue(maxsize=8)
        self.lock = asyncio.Lock()
        self.task = None
        self.encoder = None
        self.status = "loading"
        self.message = "Loading local voice recognition. Captions continue while it loads."
        self.closed = False

    def session(self, send, *, enabled=True):
        session = SpeakerSession(self, send, enabled=enabled)
        self.sessions.add(session)
        if enabled and self.task is None:
            self.task = asyncio.create_task(self._worker())
        return session

    async def _run(self, function, *args):
        return await asyncio.get_running_loop().run_in_executor(self.executor, function, *args)

    async def _worker(self):
        try:
            self.profiles = await self._run(self.store.load)
            self.broadcast()
            self.encoder = await self._run(self.encoder_factory)
            self.status = "ready"
            self.message = "Names are matched locally; uncertain voices stay anonymous."
            self.broadcast()
            for session in self.sessions:
                session.schedule_all()
            while True:
                session, speaker, audio = await self.queue.get()
                voice = session.voices.get(speaker)
                try:
                    if session.closed or voice is None:
                        continue
                    vector = unit_vector(await self._run(self.encoder, audio))
                    if not session.closed:
                        voice.embedding, voice.error = vector, None
                        session.rematch()
                except SpeakerError as error:
                    if voice is not None:
                        voice.error = str(error)
                        voice.embedding = None
                        session.rematch()
                except Exception:
                    logger.exception("Local speaker embedding failed")
                    if voice is not None:
                        voice.error = "Voice recognition could not process this sample. Try more clear speech."
                        voice.embedding = None
                        session.rematch()
                finally:
                    if voice is not None:
                        voice.pending = False
                    self.queue.task_done()
                    if not session.closed:
                        session.notify()
                    # A different session may have filled its sample while the
                    # bounded queue was full and then stopped sending audio.
                    for active in self.sessions:
                        active.schedule_all()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Local speaker recognition unavailable")
            self.status = "unavailable"
            self.message = "Local voice recognition could not load. Captions and anonymous speaker labels still work."
            self.broadcast()

    def match(self, vector):
        scores = sorted(((float(vector @ row["embedding"]), profile_id)
                         for profile_id, row in self.profiles.items()
                         if len(vector) == len(row["embedding"])), reverse=True)
        if not scores or scores[0][0] < self.threshold:
            return None
        if len(scores) > 1 and scores[0][0] - scores[1][0] < self.margin:
            return None
        return scores[0][1]

    def broadcast(self):
        for session in self.sessions:
            session.rematch()
            session.notify()

    async def save(self, profiles):
        try:
            await asyncio.to_thread(self.store.save, profiles)
        except Exception as error:
            raise SpeakerError("The voice profile could not be saved. No saved profiles were changed.") from error
        self.profiles = profiles
        self.broadcast()

    async def close(self):
        self.closed = True
        for session in list(self.sessions):
            await session.close()
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        while not self.queue.empty():
            self.queue.get_nowait()
            self.queue.task_done()
        # Running native model calls cannot be interrupted safely. Session
        # cancellation discards their result; shutdown never blocks the loop.
        self.executor.shutdown(wait=False, cancel_futures=True)


class SpeakerSession:
    def __init__(self, service, send, *, enabled):
        self.service, self.send, self.enabled = service, send, enabled
        self.voices = {}
        self.closed = False
        self.event = asyncio.Event()
        self.controls = set()
        self.pump = asyncio.create_task(self._send_states())
        self.notify()

    def notify(self):
        if not self.closed:
            self.event.set()

    def state(self):
        profiles = self.service.profiles
        voices = []
        for speaker, voice in sorted(self.voices.items()):
            row = {"speaker": speaker, "seconds": round(len(voice.audio) / SAMPLE_RATE, 1)}
            if voice.profile_id in profiles:
                row.update(name=profiles[voice.profile_id]["name"], profile_id=voice.profile_id)
            voices.append(row)
        return {"type": "speaker_state", "status": self.service.status if self.enabled else "disabled",
                "message": self.service.message if self.enabled else "Enable Remember speakers to use local voice profiles.",
                "speakers": voices, "profiles": [
                    {"id": row["id"], "name": row["name"]} for row in profiles.values()
                ] if self.enabled else []}

    async def _send_states(self):
        try:
            while True:
                await self.event.wait()
                self.event.clear()
                await self.send(self.state())
        except asyncio.CancelledError:
            raise
        except Exception:
            # WebSocket cleanup owns ending the recognition session.
            pass

    def observe(self, audio, probabilities):
        """Audio and frame posteriors must come from the SAME consumed block.

        WLK's Sortformer adds removed silence to timestamps even with buffered
        PCM remaining. Absolute transcript times therefore must not select audio.
        Posterior frame indices map directly into this exact, uncompressed block.
        """
        if not self.enabled or self.closed or self.service.status == "unavailable":
            return
        audio = np.asarray(audio, dtype=np.float32)
        probabilities = np.asarray(probabilities)
        if probabilities.ndim != 2 or probabilities.shape[1] != 4 or not len(probabilities):
            return
        if not np.isfinite(probabilities).all():
            return
        winners = probabilities.argmax(axis=1)
        ordered = np.sort(probabilities, axis=1)
        valid = (ordered[:, -1] >= 0.65) & (ordered[:, -2] <= 0.25)
        # Reject frames bordering a speaker change, not merely overlap argmax.
        valid[1:] &= winners[1:] == winners[:-1]
        valid[:-1] &= winners[:-1] == winners[1:]
        for raw_id in range(4):
            # Record anonymous voices even before enough clean audio exists.
            if not np.any(winners == raw_id):
                continue
            voice = self.voices.setdefault(raw_id + 1, Voice())
            mask = valid & (winners == raw_id)
            bounds = np.flatnonzero(np.diff(np.r_[False, mask, False]))
            for start_frame, end_frame in zip(bounds[::2], bounds[1::2]):
                start = round(start_frame * len(audio) / len(mask)) + 480
                end = round(end_frame * len(audio) / len(mask)) - 480
                piece = audio[max(0, start):max(0, end)]
                if len(piece) < 0.16 * SAMPLE_RATE or not basic_audio_quality(piece):
                    continue
                voice.audio = np.concatenate((voice.audio, piece))[-int(MAX_SECONDS * SAMPLE_RATE):]
                voice.total_samples += len(piece)
            self.schedule(raw_id + 1, voice)
        self.notify()

    def schedule(self, speaker, voice):
        minimum = int(MIN_SECONDS * SAMPLE_RATE)
        # Initial identification still needs four clean seconds. If that sample
        # was insufficient or ambiguous, retry with one more second instead of
        # adding another four-second delay. Known voices need fewer rechecks.
        interval = SAMPLE_RATE if voice.scheduled_samples and voice.profile_id is None else minimum
        if (self.closed or self.service.status != "ready" or voice.pending or len(voice.audio) < minimum
                or voice.total_samples - voice.scheduled_samples < interval):
            return
        try:
            self.service.queue.put_nowait((self, speaker, voice.audio.copy()))
        except asyncio.QueueFull:
            return
        voice.scheduled_samples = voice.total_samples
        voice.pending = True

    def schedule_all(self):
        for speaker, voice in self.voices.items():
            self.schedule(speaker, voice)

    def rematch(self):
        for voice in self.voices.values():
            if voice.explicit_id not in self.service.profiles:
                voice.explicit_id = None
            voice.profile_id = voice.explicit_id or (
                self.service.match(voice.embedding) if voice.embedding is not None else None)

    def annotate(self, payload):
        for line in payload.get("lines", []):
            voice = self.voices.get(line.get("speaker"))
            profile = self.service.profiles.get(voice.profile_id) if voice else None
            if profile:
                line["speaker_name"] = profile["name"]
        return payload

    def control(self, payload):
        if self.closed:
            return
        # Bounded per-connection controls: malformed or rapid input cannot queue
        # unbounded disk writes. The caller may send a nonfatal busy response.
        if len(self.controls) >= 4:
            return False
        task = asyncio.create_task(self._control(payload))
        self.controls.add(task)
        task.add_done_callback(self.controls.discard)
        return True

    async def _control(self, payload):
        action = str(payload.get("type", "")).removeprefix("speaker_")
        request_id = payload.get("request_id")
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 128:
            request_id = None
        ok = False
        try:
            if request_id is None:
                raise SpeakerError("Invalid speaker request identifier.")
            if action not in {"enroll", "rename", "forget"}:
                raise SpeakerError("Unsupported speaker action.")
            if not self.enabled or self.service.status != "ready":
                raise SpeakerError("Voice recognition is not ready. Captions can continue.")
            async with self.service.lock:
                profiles = {key: dict(value) for key, value in self.service.profiles.items()}
                if action == "enroll":
                    speaker = payload.get("speaker")
                    if type(speaker) is not int or speaker not in self.voices:
                        raise SpeakerError("That speaker has not provided a usable voice sample in this session.")
                    voice = self.voices[speaker]
                    name = clean_name(payload.get("name"))
                    if voice.embedding is None:
                        raise SpeakerError(voice.error or "At least four seconds of clear solo speech are needed; wait for voice analysis, then try again.")
                    existing = next((row for row in profiles.values() if row["name"].casefold() == name.casefold()), None)
                    if existing:
                        if self.service.match(voice.embedding) != existing["id"]:
                            raise SpeakerError(f"This voice does not clearly match {existing['name']}'s saved profile. Forget that profile first if you intend to replace it.")
                        profile_id = existing["id"]
                        vector = unit_vector(existing["embedding"] + voice.embedding)
                    else:
                        if len(profiles) >= MAX_PROFILES:
                            raise SpeakerError("The saved-person limit is reached. Forget a person before adding another.")
                        profile_id, vector = str(uuid.uuid4()), voice.embedding.copy()
                    profiles[profile_id] = {"id": profile_id, "name": name, "embedding": vector}
                    await self.service.save(profiles)
                    # Explicit assignment applies only to THIS session's slot.
                    voice.explicit_id = profile_id
                    self.rematch()
                    self.notify()
                    message = f"Saved {name}'s voice locally. Future uncertain matches stay anonymous."
                else:
                    profile_id = payload.get("profile_id")
                    if not isinstance(profile_id, str) or profile_id not in profiles:
                        raise SpeakerError("That saved person no longer exists.")
                    if action == "rename":
                        name = clean_name(payload.get("name"))
                        if any(row["id"] != profile_id and row["name"].casefold() == name.casefold() for row in profiles.values()):
                            raise SpeakerError("A saved person already has that name.")
                        profiles[profile_id]["name"] = name
                        message = f"Renamed the saved person to {name}."
                    else:
                        del profiles[profile_id]
                        message = "Forgot the saved voice profile."
                    await self.service.save(profiles)
                ok = True
        except SpeakerError as error:
            message = str(error)
        except Exception:
            logger.exception("Speaker profile control failed")
            message = "The speaker action could not be completed. Captions can continue."
        if not self.closed:
            try:
                await self.send({"type": "speaker_result", "action": action, "request_id": request_id,
                                 "ok": ok, "message": message})
            except Exception:
                pass

    async def close(self):
        self.closed = True
        self.service.sessions.discard(self)
        self.pump.cancel()
        # Let an already-started atomic save finish rather than cancel it between
        # disk replacement and in-memory commit. Work is short and bounded.
        await asyncio.gather(self.pump, *self.controls, return_exceptions=True)
        self.voices.clear()


class RecognitionDiarizer:
    """Tap WLK 0.2.19 Sortformer's consumed PCM, not WS/ASR timestamps."""

    def __init__(self, diarizer, session):
        self.diarizer, self.session = diarizer, session

    def __getattr__(self, key):
        return getattr(self.diarizer, key)

    async def diarize(self):
        diarizer = self.diarizer
        threshold = int(diarizer.chunk_duration_seconds * diarizer.sample_rate)
        audio = diarizer.buffer_audio[:threshold].copy() if len(diarizer.buffer_audio) >= threshold else None
        segments = await diarizer.diarize()
        if audio is not None:
            try:
                frames = diarizer._len_prediction
                probabilities = diarizer.total_preds[0, -frames:].detach().cpu().numpy()
                self.session.observe(audio, probabilities)
            except Exception:
                # Recognition is optional and must never break caption delivery.
                logger.exception("Could not align local speaker recognition audio")
        return segments
