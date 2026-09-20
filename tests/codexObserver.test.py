import sys
sys.dont_write_bytecode = True
import importlib.util
import unittest
import pathlib
import tempfile
import json
import io
from contextlib import redirect_stdout
spec = importlib.util.spec_from_file_location("observer", pathlib.Path(__file__).parents[1] / "runtime/codex-observer.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ObserverTest(unittest.TestCase):
    def record(self, payload):
        return {"type": "response_item", "timestamp": "2026-09-20T00:00:00Z", "payload": payload}

    def test_messages_and_search(self):
        event = m.normalize(self.record({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Look up languages in Europe"}]}))
        self.assertEqual(event["metadata"]["role"], "user")
        self.assertIn("Europe", event["metadata"]["text"])
        event = m.normalize(self.record({"type": "web_search_call", "id": "search1", "action": {"query": "European languages"}}))
        self.assertEqual(event["metadata"]["tool"], "web_search")

    def test_no_reasoning_system_or_full_tool_output(self):
        for payload in [{"type": "reasoning", "summary": "private"}, {"type": "message", "role": "system"}, {"type": "message", "role": "assistant", "phase": "analysis"}]:
            self.assertIsNone(m.normalize(self.record(payload)))
        event = m.normalize(self.record({"type": "function_call_output", "call_id": "1", "output": "sensitive file contents"}))
        self.assertNotIn("sensitive", json.dumps(event))

    def test_secrets_and_bounds(self):
        self.assertNotIn("abc123", json.dumps(m.clean({"text": "Bearer abc123 PASSWORD=abc123", "api_key": "abc123"})))
        self.assertLess(len(m.clean("x" * 50000)), 12100)

    def test_outcomes_and_patch_attribution(self):
        calls = {}
        m.normalize(self.record({"type": "custom_tool_call", "name": "apply_patch", "call_id": "patch", "input": "*** Begin Patch\n*** Update File: src/a.txt\n*** End Patch"}), calls)
        event = m.normalize(self.record({"type": "custom_tool_call_output", "call_id": "patch", "output": json.dumps({"output": "Success. Updated the following files:\nM src/a.txt\n"})}), calls)
        self.assertEqual(event["metadata"]["changedFiles"], ["src/a.txt"])
        self.assertEqual(event["metadata"]["outcome"], "succeeded")
        denied = m.normalize(self.record({"type": "function_call_output", "call_id": "other", "output": "Process exited with code 1\nbash: infra/prod.tf: Read-only file system\n"}), calls)
        self.assertEqual(denied["metadata"]["outcome"], "denied")
        self.assertEqual(denied["metadata"]["exitCode"], 1)
        self.assertNotIn("infra/prod.tf", json.dumps(denied))
        ordinary = m.normalize(self.record({"type": "function_call_output", "call_id": "other", "output": "Success. Updated the following files:\nM infra/prod.tf\n"}), calls)
        self.assertNotIn("changedFiles", ordinary["metadata"])

    def test_partial_lines_and_dedup(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = pathlib.Path(tmp) / "log.jsonl"
            record = self.record({"type": "function_call", "name": "exec_command", "arguments": '{"cmd":"echo hello"}', "call_id": "one"})
            encoded = json.dumps(record)
            p.write_text(encoded[:40])
            cursors, seen = {}, set()
            output = io.StringIO()
            with redirect_stdout(output):
                m.poll(pathlib.Path(tmp), cursors, seen)
                with p.open("a") as f: f.write(encoded[40:] + "\n" + encoded + "\n")
                m.poll(pathlib.Path(tmp), cursors, seen)
                m.poll(pathlib.Path(tmp), cursors, seen)
            self.assertEqual(output.getvalue().count("AGENTGUARD_EVENT"), 1)

unittest.main()
