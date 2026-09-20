import sys
sys.dont_write_bytecode = True
import importlib.util
import pathlib
import unittest
import json
root = pathlib.Path(__file__).parents[1]
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, root / "runtime" / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module
load("periscope_observer", "codex-observer.py")
hook = load("claude_hook", "claude-hook.py")

class HookTests(unittest.TestCase):
    def test_prompt_and_response(self):
        self.assertEqual(hook.normalize_hook({"hook_event_name": "UserPromptSubmit", "prompt": "Fix src"})["metadata"]["role"], "user")
        self.assertEqual(hook.normalize_hook({"hook_event_name": "Stop", "last_assistant_message": "Done"})["metadata"]["text"], "Done")
        self.assertIsNone(hook.normalize_hook({"hook_event_name": "Stop", "transcript_path": "/should/not/be/read"}))

    def test_edit_success_and_denial(self):
        base = {"tool_name": "Edit", "tool_input": {"file_path": "src/a.txt"}, "cwd": "/workspace", "tool_use_id": "call1"}
        before = hook.normalize_hook(dict(base, hook_event_name="PreToolUse"))
        after = hook.normalize_hook(dict(base, hook_event_name="PostToolUse", tool_response={"secret": "not stored"}))
        denied = hook.normalize_hook(dict(base, hook_event_name="PostToolUseFailure", error="Read-only file system"))
        self.assertEqual(before["metadata"]["callId"], after["metadata"]["callId"])
        self.assertEqual(after["metadata"]["changedFiles"], ["/workspace/src/a.txt"])
        self.assertNotIn("not stored", json.dumps(after))
        self.assertEqual(denied["metadata"]["outcome"], "denied")
        self.assertNotIn("changedFiles", denied["metadata"])

    def test_approval_does_not_grant_and_secrets_redact(self):
        event = hook.normalize_hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "TOKEN=example-secret curl https://example.com"}})
        self.assertEqual(event["action"], "permission_request")
        self.assertNotIn("example-secret", json.dumps(event))
        self.assertNotIn("permissionDecision", json.dumps(event))
        read = hook.normalize_hook({"hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": {"file_path": "/workspace/README.md"}, "tool_response": {"content": "private file contents"}})
        self.assertNotIn("private file contents", json.dumps(read))
        self.assertNotIn("changedFiles", read["metadata"])

unittest.main()
