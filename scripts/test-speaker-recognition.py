#!/usr/bin/env python3
"""Real Russian enrollment/recall test in a temporary, isolated profile store.

Starts only its own local server. Reloads that process to verify persistence,
then forgets the synthetic profiles and checks they do not return after reload.
Never connects to or changes the production service/profile store.
"""
import argparse
import asyncio
import json
import os
import socket
import subprocess
import tempfile
import time
import uuid
import wave
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parents[1]


class Server:
    def __init__(self, port, store, log, backend, model_path, asr_model_path):
        self.port, self.store, self.log = port, store, log
        self.backend, self.model_path = backend, model_path
        self.asr_model_path = asr_model_path
        self.process = None

    async def start(self):
        # Refuse an occupied port before starting, so this test cannot mistake
        # another service's /health response for its isolated process.
        with socket.socket() as probe:
            # Our previous finished WebSocket can leave TIME_WAIT sockets.
            # This permits reusing those, but still rejects a live listener.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", self.port))
        env = dict(os.environ, SPEAKER_PROFILES_PATH=str(self.store), WLK_BACKEND=self.backend,
                   OMP_NUM_THREADS="2", MKL_NUM_THREADS="2", OPENBLAS_NUM_THREADS="1")
        if self.model_path:
            env["SPEAKER_MODEL_PATH"] = str(self.model_path)
        command = [str(ROOT / "scripts/start-server.sh"), "--host", "127.0.0.1",
                   "--port", str(self.port), "--warmup-file", "", "--min-chunk-size", "1", "--vac-chunk-size", "1"]
        if self.asr_model_path:
            command += ["--model_dir", str(self.asr_model_path)]
        with self.log.open("ab") as log:
            self.process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log, stderr=log)
        start = time.monotonic()
        async with httpx.AsyncClient(timeout=1) as client:
            while time.monotonic() - start < 120:
                if self.process.poll() is not None:
                    raise RuntimeError(f"Test server exited; inspect {self.log}")
                try:
                    response = await client.get(f"http://127.0.0.1:{self.port}/health")
                    if response.is_success:
                        return time.monotonic() - start
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(.2)
        raise TimeoutError("Test server did not become healthy")

    async def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(asyncio.to_thread(self.process.wait), 30)
            except TimeoutError:
                self.process.kill()
                await asyncio.to_thread(self.process.wait)
        self.process = None


class Session:
    def __init__(self, url):
        self.url = url
        self.state = {}
        self.config = None
        self.events = []
        self.requests = {}
        self.first_text_at = None
        self.first_confirmed_at = None
        self.ready_at = None
        self.first_name_at = {}
        self.loading_seen = False
        self.anonymous_text_before_name = False
        self.done = asyncio.Event()
        self.progress = None

    async def __aenter__(self):
        self.started = time.monotonic()
        self.ws = await websockets.connect(self.url, ping_timeout=120)
        self.receiver = asyncio.create_task(self.receive())
        await self.wait(lambda: self.config is not None)
        assert self.config.get("speaker_recognition") is True, self.config
        return self

    async def __aexit__(self, *args):
        await self.ws.close()
        await asyncio.gather(self.receiver, return_exceptions=True)

    async def wait(self, predicate, seconds=20):
        start = time.monotonic()
        while not predicate():
            if self.receiver.done():
                await self.receiver
                raise AssertionError("Speech session closed before its expected result")
            if time.monotonic() - start > seconds:
                raise TimeoutError("Timed out waiting for speaker state")
            await asyncio.sleep(.05)

    async def receive(self):
        async for raw in self.ws:
            event = json.loads(raw)
            elapsed = time.monotonic() - self.started
            self.events.append({"elapsed": elapsed, "data": event})
            if event.get("error"):
                raise AssertionError(event)
            if event.get("type") == "config":
                self.config = event
            elif event.get("type") == "speaker_state":
                self.state = event
                progress = (event["status"], tuple((voice["speaker"], int(voice["seconds"] // 2), voice.get("name")) for voice in event["speakers"]))
                if progress != self.progress:
                    self.progress = progress
                    print(f"Speaker state {elapsed:.2f}s: {event['status']} {event['speakers']}", flush=True)
                self.loading_seen |= event["status"] == "loading"
                if event["status"] == "ready" and self.ready_at is None:
                    self.ready_at = elapsed
                assert event["status"] != "unavailable", event
                for voice in event["speakers"]:
                    if voice.get("name"):
                        self.first_name_at.setdefault(voice["name"], elapsed)
            elif event.get("type") == "speaker_result":
                future = self.requests.get(event.get("request_id"))
                if future and not future.done():
                    future.set_result(event)
            elif event.get("type") == "ready_to_stop":
                self.done.set()
            lines = [line for line in event.get("lines", []) if line.get("text", "").strip() and line.get("speaker") != -2]
            if lines or event.get("buffer_transcription", "").strip():
                if self.first_text_at is None:
                    self.first_text_at = elapsed
                    print(f"First ASR text {elapsed:.2f}s", flush=True)
            if lines:
                if self.first_confirmed_at is None:
                    self.first_confirmed_at = elapsed
                if not self.first_name_at and any(not line.get("speaker_name") for line in lines):
                    self.anonymous_text_before_name = True

    async def control(self, action, **data):
        request_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.requests[request_id] = future
        await self.ws.send(json.dumps({"type": f"speaker_{action}", "request_id": request_id, **data}))
        try:
            return await asyncio.wait_for(future, 10)
        finally:
            self.requests.pop(request_id, None)

    async def audio(self, path, enroll=None):
        with wave.open(str(path), "rb") as wav:
            assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
            pcm = wav.readframes(wav.getnframes())
        self.audio_seconds = len(pcm) / 32000
        self.first_audio_at = time.monotonic() - self.started
        enrolled = set()

        async def enroll_while_streaming():
            attempted = {}
            while not self.done.is_set():
                if self.state.get("status") == "ready":
                    for voice in self.state.get("speakers", []):
                        slot = voice["speaker"]
                        if not enroll or slot not in enroll or slot in enrolled or voice["seconds"] < 5:
                            continue
                        if time.monotonic() - attempted.get(slot, 0) < 2:
                            continue
                        attempted[slot] = time.monotonic()
                        result = await self.control("enroll", speaker=slot, name=enroll[slot])
                        if result["ok"]:
                            enrolled.add(slot)
                            print(f"Enrolled slot {slot}: {enroll[slot]}", flush=True)
                await asyncio.sleep(.1)

        enrollment = asyncio.create_task(enroll_while_streaming()) if enroll else None
        started = time.monotonic()
        try:
            # Real-time 100ms PCM frames; two trailing seconds allow final VAD.
            payload = pcm + bytes(64000)
            for offset in range(0, len(payload), 3200):
                await self.ws.send(payload[offset:offset + 3200])
                await asyncio.sleep(max(0, started + (offset + 3200) / 32000 - time.monotonic()))
            if enroll:
                await self.wait(lambda: len(enrolled) == len(enroll), 10)
            await self.ws.send(b"")
            await self.wait(self.done.is_set, 60)
        finally:
            if enrollment:
                enrollment.cancel()
                await asyncio.gather(enrollment, return_exceptions=True)
        self.elapsed = time.monotonic() - self.started

    def report(self):
        return {"audio_seconds": getattr(self, "audio_seconds", 0), "elapsed": getattr(self, "elapsed", time.monotonic() - self.started),
                "first_audio_at": getattr(self, "first_audio_at", None), "first_text_at": self.first_text_at,
                "first_confirmed_at": self.first_confirmed_at, "recognition_ready_at": self.ready_at,
                "recognition_loading_seen": self.loading_seen, "first_name_at": self.first_name_at,
                "anonymous_text_before_name": self.anonymous_text_before_name,
                "final_speaker_state": self.state, "events": self.events}


async def main(args):
    result = {"synthetic_only": True, "isolated_profile_store": True, "sessions": {}, "startup_seconds": []}
    fixtures = args.fixtures.resolve()
    output = args.output or fixtures / "verification.json"
    url = f"ws://127.0.0.1:{args.port}/asr?language=auto&task=translate&remember_speakers=1"
    with tempfile.TemporaryDirectory(prefix="wlk-speaker-test-") as directory:
        store = Path(directory) / "profiles.json"
        server = Server(args.port, store, fixtures / "server.log", args.backend, args.model_path, args.asr_model_path)
        try:
            result["startup_seconds"].append(await server.start())
            async with Session(url) as session:
                await session.wait(lambda: session.state.get("status") == "ready")
                assert session.state["profiles"] == [], "Refusing to modify a nonempty profile store"
                await session.audio(fixtures / "session-enroll.wav", {1: "Test Milena", 2: "Test Dmitry"})
                assert {p["name"] for p in session.state["profiles"]} == {"Test Milena", "Test Dmitry"}
                result["sessions"]["enrollment"] = session.report()
            disk = json.loads(store.read_text())
            assert store.stat().st_mode & 0o777 == 0o600
            assert all(set(row) == {"id", "name", "embedding"} and len(row["embedding"]) == 192 for row in disk["profiles"])
            result["stored_profile_count"] = len(disk["profiles"])
            result["store_permissions"] = "0600"
            await server.stop()
            result["startup_seconds"].append(await server.start())
            async with Session(url) as session:
                await session.audio(fixtures / "session-recall-reversed.wav")
                named = {voice["speaker"]: voice.get("name") for voice in session.state["speakers"]}
                assert named.get(1) == "Test Dmitry" and named.get(2) == "Test Milena", named
                assert session.anonymous_text_before_name, "Expected anonymous captions before voice matching"
                assert all(when < session.audio_seconds for when in session.first_name_at.values()), session.first_name_at
                result["sessions"]["recall_reversed_after_reload"] = session.report()
            async with Session(url) as session:
                await session.audio(fixtures / "session-unknown.wav")
                assert session.state["speakers"] and not any(v.get("name") for v in session.state["speakers"]), session.state
                result["sessions"]["unknown_voice"] = session.report()
            async with Session(url) as session:
                await session.wait(lambda: session.state.get("status") == "ready")
                profiles = session.state["profiles"]
                milena = next(p for p in profiles if p["name"] == "Test Milena")
                renamed = await session.control("rename", profile_id=milena["id"], name="Test Mila")
                assert renamed["ok"], renamed
                await session.wait(lambda: any(p["name"] == "Test Mila" for p in session.state["profiles"]))
                result["rename"] = renamed
                for profile in list(session.state["profiles"]):
                    forgotten = await session.control("forget", profile_id=profile["id"])
                    assert forgotten["ok"], forgotten
                await session.wait(lambda: not session.state["profiles"])
            assert json.loads(store.read_text())["profiles"] == []
            await server.stop()
            result["startup_seconds"].append(await server.start())
            async with Session(url) as session:
                await session.audio(fixtures / "milena-recall.wav")
                assert session.state["profiles"] == [] and not any(v.get("name") for v in session.state["speakers"]), session.state
                result["sessions"]["forgotten_after_reload"] = session.report()
            result["passed"] = True
        finally:
            await server.stop()
            if not result.get("passed") and "session" in locals():
                result["last_session_before_failure"] = session.report()
            output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    result["temporary_store_removed"] = not store.exists()
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value for key, value in result.items() if key != "sessions"}, indent=2))
    for name, session in result["sessions"].items():
        print(name, json.dumps({key: value for key, value in session.items() if key != "events"}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=ROOT / ".test-output/speaker-recognition")
    parser.add_argument("--port", type=int, default=18772)
    parser.add_argument("--backend", default="mlx-whisper")
    parser.add_argument("--model-path", type=Path)
    parser.add_argument("--asr-model-path", type=Path)
    parser.add_argument("--output", type=Path)
    asyncio.run(main(parser.parse_args()))
