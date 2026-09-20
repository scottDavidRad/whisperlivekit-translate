import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from server import codex_provider as provider


class FakeInput:
    def __init__(self):
        self.messages = []

    def write(self, value):
        self.messages.append(json.loads(value))

    async def drain(self):
        pass


class FakeProcess:
    def __init__(self, events):
        self.stdin = FakeInput()
        self.stdout = asyncio.StreamReader()
        for event in events:
            self.stdout.feed_data(json.dumps(event).encode() + b"\n")
        self.stdout.feed_eof()


def initial_events():
    return [{"id": 1, "result": {}}, {"id": 2, "result": {"thread": {"id": "isolated"}}},
            {"id": 3, "result": {}}]


class CodexProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_response_and_capability_boundaries(self):
        events = initial_events() + [
            {"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": '{"text":"A short cue"}'}}},
            {"method": "turn/completed", "params": {"turn": {"status": "completed"}}},
        ]
        process = FakeProcess(events)
        result = await provider._exchange(process, "private meeting", {"type": "object"}, "gpt-5.5", Path("/tmp/isolated"))
        self.assertEqual(json.loads(result)["text"], "A short cue")
        thread = next(x["params"] for x in process.stdin.messages if x.get("method") == "thread/start")
        turn = next(x["params"] for x in process.stdin.messages if x.get("method") == "turn/start")
        self.assertEqual(thread["environments"], [])
        self.assertEqual(turn["environments"], [])
        self.assertEqual(thread["dynamicTools"], [])
        self.assertTrue(thread["ephemeral"])
        self.assertEqual(thread["sandbox"], "read-only")
        self.assertEqual(thread["approvalPolicy"], "never")
        self.assertEqual(turn["effort"], "low")
        self.assertEqual(turn["input"][0]["text"], "private meeting")

    async def test_server_requests_never_granted(self):
        for event in (
            {"id": 100, "method": "item/commandExecution/requestApproval", "params": {}},
            {"method": "item/started", "params": {"item": {"type": "mcpToolCall"}}},
            {"method": "item/started", "params": {"item": {"type": "fileChange"}}},
        ):
            with self.subTest(event=event):
                with self.assertRaisesRegex(provider.CodexError, "unavailable operation"):
                    await provider._exchange(FakeProcess(initial_events() + [event]), "test", {}, "gpt-5.5", Path("/tmp/isolated"))

    async def test_remote_errors_are_sanitized(self):
        process = FakeProcess([{"id": 1, "error": {"message": "secret-token-not-for-client"}}])
        with self.assertRaises(provider.CodexError) as result:
            await provider._exchange(process, "test", {}, "gpt-5.5", Path("/tmp/isolated"))
        self.assertNotIn("secret-token", str(result.exception))

    async def test_invalid_input_does_not_start_process(self):
        with patch.object(provider, "get_config", new_callable=AsyncMock) as status:
            for prompt in ("", "a" * (provider.MAX_PROMPT_BYTES + 1)):
                with self.assertRaises(provider.CodexError):
                    await provider.generate(prompt, {})
            status.assert_not_called()

    async def test_command_disables_integrations_and_has_no_transcript(self):
        with patch.object(provider, "_mcp_names", return_value={"private_service"}):
            args = provider._command("/usr/local/bin/codex", Path("/tmp/isolated"))
        self.assertIn("mcp_servers.private_service.enabled=false", args)
        self.assertIn('web_search="disabled"', args)
        self.assertIn("project_doc_max_bytes=0", args)
        self.assertIn("notify=[]", args)
        self.assertEqual(args[-1], "app-server")
        for feature in ("apps", "plugins", "hooks", "multi_agent", "shell_tool"):
            position = args.index(feature)
            self.assertEqual(args[position - 1], "--disable")

    async def test_unsafe_mcp_key_fails_closed(self):
        with patch.object(provider, "_mcp_names", return_value={"unhandled.dot"}):
            with self.assertRaises(provider.CodexError):
                provider._command("codex", Path("/tmp/isolated"))

    async def test_timeout_and_cancellation_kill_process_group(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                process = AsyncMock()
                process.returncode = None
                process.pid = 12345
                async def stalled(*args):
                    await asyncio.sleep(60)
                with (patch.object(provider, "get_config", AsyncMock(return_value={"configured": True})),
                      patch.object(provider, "_binary", return_value="codex"),
                      patch.object(provider, "_mcp_names", return_value=set()),
                      patch.object(provider, "_exchange", side_effect=stalled),
                      patch.object(provider.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)) as spawn,
                      patch.object(provider.os, "killpg") as kill,
                      patch.object(provider, "TIMEOUT_SECONDS", 0.01)):
                    task = asyncio.create_task(provider.generate("private meeting", {}))
                    if cancel:
                        while not spawn.called:
                            await asyncio.sleep(0)
                        task.cancel()
                    with self.assertRaises(asyncio.CancelledError if cancel else provider.CodexError):
                        await task
                    kill.assert_called_once_with(12345, provider.signal.SIGKILL)
                    process.wait.assert_awaited()
                    self.assertNotIn("private meeting", spawn.call_args.args)
                    self.assertTrue(spawn.call_args.kwargs["start_new_session"])
                    self.assertFalse(Path(spawn.call_args.kwargs["cwd"]).exists())

    async def test_descendants_are_killed_after_parent_exit(self):
        process = AsyncMock()
        process.pid = 12345
        process.returncode = 0
        with patch.object(provider.os, "killpg") as kill:
            await provider._stop(process)
        kill.assert_called_once_with(12345, provider.signal.SIGKILL)


if __name__ == "__main__":
    unittest.main()
