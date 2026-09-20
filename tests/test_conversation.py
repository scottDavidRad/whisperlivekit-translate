"""Run with: .venv/bin/python -m unittest discover -s tests -p 'test_*.py'."""

import asyncio
import importlib.util
import json
import threading
import unittest
from unittest.mock import AsyncMock, patch
from argparse import Namespace
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from pydantic import ValidationError

from server.conversation import (
    ConversationConfig, ConversationError, ConversationService, CueRequest,
    SummaryRequest, conversation_router,
)


def completion(content):
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


class ConfigurationTests(unittest.TestCase):
    def test_matching_provider_keys_only(self):
        xai = ConversationConfig.from_env({"XAI_API_KEY": "xai-test", "OPENAI_API_KEY": "openai-test"})
        self.assertEqual((xai.provider, xai.model, xai.api_key), ("grok", "grok-4.6", "xai-test"))
        self.assertNotIn("xai-test", repr(xai))
        self.assertNotIn("xai-test", json.dumps(xai.public()))
        custom = ConversationConfig.from_env({"CONVERSATION_BASE_URL": "http://localhost:1234/v1",
                                              "CONVERSATION_MODEL": "local", "OPENAI_API_KEY": "openai-test",
                                              "XAI_API_KEY": "xai-test"}, "openai-compatible")
        self.assertEqual(custom.api_key, "")
        self.assertFalse(custom.public()["configured"])
        openai = ConversationConfig.from_env({"CONVERSATION_BASE_URL": "https://api.openai.com/v1",
                                              "CONVERSATION_MODEL": "chosen-model", "OPENAI_API_KEY": "openai-test"}, "openai-compatible")
        self.assertEqual(openai.api_key, "openai-test")
        override = ConversationConfig.from_env({"XAI_API_KEY": "fallback", "CONVERSATION_API_KEY": "explicit"}, "openai-compatible")
        self.assertEqual(override.api_key, "explicit")

    def test_bad_url_missing_model_and_cloud_keyless_rejected(self):
        for env in ({"CONVERSATION_BASE_URL": "https://user:password@example.com/v1"},
                    {"CONVERSATION_BASE_URL": "file:///tmp/provider"},
                    {"CONVERSATION_BASE_URL": "https://api.openai.com/v1", "OPENAI_API_KEY": "test"},
                    {"CONVERSATION_ALLOW_KEYLESS": "1"}):
            with self.subTest(env=env):
                self.assertFalse(ConversationConfig.from_env(env, "openai-compatible").public()["configured"])

    def test_inputs_bounded(self):
        for kwargs in ({"transcript": "x" * 20_001},
                       {"transcript": "x", "prep_notes": "x" * 8_001},
                       {"transcript": "x", "previous_cues": ["x"] * 21},
                       {"transcript": "x", "previous_cues": ["x" * 401]}):
            with self.assertRaises(ValidationError):
                CueRequest(**kwargs)
        with self.assertRaises(ValidationError):
            SummaryRequest(transcript="x" * 100_001)

    def test_qwen_defaults_and_scoped_dashscope_fallback(self):
        qwen = ConversationConfig.from_env({"DASHSCOPE_API_KEY": "dashscope-test"}, "qwen")
        self.assertEqual(qwen.model, "qwen3.8-flash")
        self.assertEqual(qwen.api_key, "dashscope-test")
        self.assertEqual(qwen.base_url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")
        custom = ConversationConfig.from_env({"QWEN_BASE_URL": "https://other.example/v1",
                                              "DASHSCOPE_API_KEY": "must-not-leak"}, "qwen")
        self.assertEqual(custom.api_key, "")


class ConversationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.services = []

    async def asyncTearDown(self):
        for service in self.services:
            await service.close()

    def service(self, handler, *, env=None, **kwargs):
        config = ConversationConfig.from_env({"XAI_API_KEY": "test-secret"} if env is None else env,
                                             "openai-compatible" if env and "CONVERSATION_BASE_URL" in env else "grok")
        service = ConversationService(config, transport=httpx.MockTransport(handler), **kwargs)
        self.services.append(service)
        return service

    async def test_success_uses_minimal_chat_contract(self):
        def handler(request):
            self.assertEqual(str(request.url), "https://api.x.ai/v1/chat/completions")
            self.assertEqual(request.headers["Authorization"], "Bearer test-secret")
            body = json.loads(request.content)
            self.assertEqual(set(body), {"model", "messages", "stream"})
            self.assertIs(body["stream"], False)
            self.assertEqual(body["model"], "grok-4.6")
            data = json.loads(body["messages"][1]["content"])
            self.assertEqual(data["previous_cues"], ["Earlier cue"])
            return completion('```json\n{"kind":"concept","text":"Latency means delay."}\n```')
        result = await self.service(handler).cue(CueRequest(transcript="What is latency?", previous_cues=["Earlier cue"]))
        self.assertEqual(result.model_dump(), {"kind": "concept", "text": "Latency means delay."})

    async def test_plain_cue_and_none(self):
        service = self.service(lambda _: completion("Ask which deadline matters most."))
        self.assertEqual((await service.cue(CueRequest(transcript="We have two deadlines."))).kind, "suggestion")
        service = self.service(lambda _: completion('{"kind":"none","text":"ignored"}'))
        self.assertEqual((await service.cue(CueRequest(transcript="Hello"))).model_dump(), {"kind": "none", "text": ""})

    async def test_qwen_dispatch_disables_thinking_for_fast_cues(self):
        def handler(request):
            body = json.loads(request.content)
            self.assertEqual(body["model"], "qwen3.8-flash")
            self.assertIs(body["enable_thinking"], False)
            self.assertEqual(request.headers["Authorization"], "Bearer qwen-test")
            return completion('{"kind":"answer","text":"Four."}')
        service = ConversationService(environ={"QWEN_API_KEY": "qwen-test"}, transport=httpx.MockTransport(handler))
        self.services.append(service)
        result = await service.cue(CueRequest(provider="qwen", transcript="Two plus two?"))
        self.assertEqual(result.text, "Four.")

    async def test_summary_and_plain_fallback(self):
        service = self.service(lambda _: completion('{"summary":"They agreed to meet.","action_items":["Send the invitation."]}'))
        result = await service.summary(SummaryRequest(transcript="I will send an invitation."))
        self.assertEqual(result.action_items, ["Send the invitation."])
        plain = self.service(lambda _: completion("They discussed the meeting."))
        self.assertEqual((await plain.summary(SummaryRequest(transcript="About the meeting..."))).action_items, [])

    async def test_missing_key_does_not_call_provider(self):
        service = self.service(lambda _: self.fail("Unconfigured provider was called"), env={})
        with self.assertRaises(ConversationError) as error:
            await service.cue(CueRequest(transcript="Hello"))
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn("API key", str(error.exception))

    async def test_explicit_local_keyless_sends_no_foreign_key(self):
        def handler(request):
            self.assertNotIn("authorization", request.headers)
            self.assertEqual(str(request.url), "http://127.0.0.1:1234/v1/chat/completions")
            return completion('{"kind":"answer","text":"Four."}')
        env = {"CONVERSATION_BASE_URL": "http://127.0.0.1:1234/v1", "CONVERSATION_MODEL": "local-model",
               "CONVERSATION_ALLOW_KEYLESS": "1", "OPENAI_API_KEY": "must-not-leak"}
        result = await self.service(handler, env=env).cue(CueRequest(transcript="Two plus two?"))
        self.assertEqual(result.text, "Four.")

    async def test_provider_failures_are_sanitized(self):
        for status, expected in ((401, 502), (403, 502), (429, 503), (500, 502), (302, 502)):
            service = self.service(lambda _, status=status: httpx.Response(status, text="test-secret raw upstream error"))
            with self.subTest(status=status), self.assertRaises(ConversationError) as error:
                await service.cue(CueRequest(transcript="Hi"))
            self.assertEqual(error.exception.status_code, expected)
            self.assertNotIn("test-secret", str(error.exception))
            self.assertNotIn("raw upstream", str(error.exception))

    async def test_malformed_and_oversized_responses(self):
        for response in (httpx.Response(200, text="not-json"), completion('{"kind":'),
                         completion('{"kind":"unknown","text":"x"}'),
                         completion('{"kind":"answer","text":42}'), completion("x" * 70_000),
                         httpx.Response(200, json={"choices": []})):
            service = self.service(lambda _, response=response: response)
            with self.assertRaises(ConversationError):
                await service.cue(CueRequest(transcript="Hi"))

    async def test_timeout_and_transport_errors(self):
        async def slow(_):
            await asyncio.sleep(0.1)
            return completion("Too late")
        with self.assertRaises(ConversationError) as error:
            await self.service(slow, timeout=0.01).cue(CueRequest(transcript="Hi"))
        self.assertEqual(error.exception.status_code, 504)
        def broken(_):
            raise httpx.ConnectError("test-secret internal hostname")
        with self.assertRaises(ConversationError) as error:
            await self.service(broken).cue(CueRequest(transcript="Hi"))
        self.assertNotIn("test-secret", str(error.exception))

    async def test_concurrency_bound_and_slot_release(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def slow(_):
            entered.set()
            await release.wait()
            return completion('{"kind":"none","text":""}')
        service = self.service(slow, max_concurrent=1, queue_timeout=0.01)
        first = asyncio.create_task(service.cue(CueRequest(transcript="First")))
        await entered.wait()
        with self.assertRaises(ConversationError) as error:
            await service.cue(CueRequest(transcript="Second"))
        self.assertEqual(error.exception.status_code, 503)
        release.set()
        await first
        self.assertEqual((await service.cue(CueRequest(transcript="Third"))).kind, "none")

    async def test_codex_default_dispatch_and_provider_selection(self):
        service = ConversationService(environ={}, transport=httpx.MockTransport(lambda _: self.fail("Unexpected HTTP")))
        self.services.append(service)
        helper = SimpleNamespace(
            get_config=AsyncMock(return_value={"provider": "codex", "model": "configured-model", "configured": True, "reason": ""}),
            generate=AsyncMock(return_value='{"kind":"answer","text":"Four."}'),
        )
        with patch.object(service, "_codex", return_value=helper):
            self.assertEqual((await service.public_config())["provider"], "codex")
            self.assertEqual((await service.cue(CueRequest(transcript="Two plus two?"))).text, "Four.")
            helper.generate.assert_awaited_once()
        self.assertFalse((await service.public_config("grok"))["configured"])
        self.assertFalse((await service.public_config("qwen"))["configured"])
        with self.assertRaises(ValidationError):
            CueRequest(provider="arbitrary", transcript="Hi")

    async def test_http_routes_config_validation_and_errors(self):
        service = self.service(lambda _: completion('{"kind":"suggestion","text":"Ask about timing."}'))
        app = FastAPI()
        app.include_router(conversation_router(service))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            config = (await client.get("/conversation/config")).json()
            self.assertTrue(config["configured"])
            self.assertNotIn("test-secret", json.dumps(config))
            response = await client.post("/conversation/cue", json={"transcript": "When?"})
            self.assertEqual(response.json(), {"kind": "suggestion", "text": "Ask about timing."})
            self.assertEqual((await client.post("/conversation/cue", json={"transcript": "x" * 20_001})).status_code, 422)
            self.assertEqual((await client.post("/conversation/cue", json={"transcript": "   "})).status_code, 422)


@unittest.skipUnless(importlib.util.find_spec("whisperlivekit"), "WhisperLiveKit runtime dependencies are not installed")
class SessionIsolationTests(unittest.TestCase):
    def test_mlx_initialization_and_inference_share_one_thread(self):
        from server.app import LiveMLXWhisper, create_app
        from whisperlivekit.config import WhisperLiveKitConfig
        thread_ids = []

        def engine_factory(**kwargs):
            thread_ids.append(threading.get_ident())
            asr = object.__new__(LiveMLXWhisper)
            asr.original_language = None
            asr.transcribe_kargs = {"task": "translate"}
            asr.model_size_or_path = "test-model"

            def model(audio, **options):
                thread_ids.append(threading.get_ident())
                return {"segments": []}

            asr.model = model
            return SimpleNamespace(asr=asr)

        async def exercise():
            config = WhisperLiveKitConfig(backend="mlx-whisper", backend_policy="localagreement", beams=1, pcm_input=True)
            with patch("server.app.TranscriptionEngine", side_effect=engine_factory), \
                    patch("server.app.supported_languages", return_value=["en"]):
                app = create_app(config)
                async with app.router.lifespan_context(app):
                    await asyncio.gather(*(asyncio.to_thread(app.state.engine.asr.transcribe, []) for _ in range(4)))

        asyncio.run(exercise())
        self.assertEqual(len(thread_ids), 5)
        self.assertEqual(len(set(thread_ids)), 1)
        self.assertNotEqual(thread_ids[0], threading.get_ident())

    def test_mlx_forwards_task_without_replaying_committed_context(self):
        from server.app import LiveMLXWhisper
        asr = object.__new__(LiveMLXWhisper)
        asr.original_language = "ru"
        asr.transcribe_kargs = {"task": "translate"}
        asr.model_size_or_path = "test-shared-model"
        asr.inference_lock = threading.Lock()
        def model(audio, **options):
            self.assertTrue(asr.inference_lock.locked())
            self.assertEqual(options["task"], "translate")
            self.assertEqual(options["language"], "ru")
            self.assertIsNone(options["initial_prompt"])
            self.assertFalse(options["condition_on_previous_text"])
            self.assertTrue(options["word_timestamps"])
            self.assertEqual(options["temperature"], 0.0)
            return {"segments": [{"text": "Translated words"}]}
        asr.model = model
        self.assertEqual(asr.transcribe([], init_prompt="Previously committed text"), [{"text": "Translated words"}])

    def test_task_and_language_are_independent_with_shared_weights(self):
        from server.app import session_engine
        from whisperlivekit import TranscriptionEngine
        from whisperlivekit.config import WhisperLiveKitConfig
        shared = object.__new__(TranscriptionEngine)
        shared.config = WhisperLiveKitConfig(lan="auto", direct_english_translation=True)
        shared.args = Namespace(lan="auto", direct_english_translation=True)
        weights = object()
        shared.asr = SimpleNamespace(original_language=None, model=weights, transcribe_kargs={"task": "translate"})
        captions = session_engine(shared, "ru", "transcribe")
        translation = session_engine(shared, "es", "translate")
        self.assertIs(captions.asr.model, translation.asr.model)
        self.assertEqual(captions.asr.original_language, "ru")
        self.assertEqual(translation.asr.original_language, "es")
        self.assertEqual(captions.asr.transcribe_kargs["task"], "transcribe")
        self.assertEqual(translation.asr.transcribe_kargs["task"], "translate")
        self.assertEqual(shared.asr.transcribe_kargs["task"], "translate")
        self.assertFalse(captions.args.direct_english_translation)
        self.assertTrue(shared.config.direct_english_translation)
        self.assertEqual(shared.args.lan, "auto")


if __name__ == "__main__":
    unittest.main()
