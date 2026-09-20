"""Observe Claude's public hook payload; never return permission decisions."""
import json
import os
import sys
import fcntl
from periscope_observer import clean, result_summary


def normalize_hook(payload):
    kind = payload.get("hook_event_name")
    tool = payload.get("tool_name", "tool")
    args = payload.get("tool_input") or {}
    meta = {"source": "claude_hooks", "agentName": "Claude Code", "callId": payload.get("tool_use_id"), "cwd": payload.get("cwd", "/workspace")}
    action = None
    if kind == "SessionStart":
        action = "message"
        meta.update(role="notice", text="Claude Code action logging connected. Full tool output and private reasoning are not recorded.")
    elif kind == "UserPromptSubmit":
        action = "message"
        meta.update(role="user", text=payload.get("prompt", ""))
    elif kind == "Stop" and payload.get("last_assistant_message"):
        action = "message"
        meta.update(role="assistant", text=payload["last_assistant_message"])
    elif kind == "PreToolUse":
        action = "tool_call"
        meta.update(tool=tool, arguments=args)
    elif kind == "PermissionRequest":
        action = "permission_request"
        meta.update(tool=tool, arguments=args, text="Claude requested approval in your terminal. Periscope has not approved it.")
    elif kind in ("PostToolUse", "PostToolUseFailure"):
        action = "tool_result"
        summary = result_summary(payload.get("tool_response", payload.get("error", "")))
        summary.pop("changedFiles", None)
        meta.update(tool=tool, **summary)
        if kind == "PostToolUseFailure":
            meta["outcome"] = "denied" if meta.get("reasons") else "failed"
        else:
            # Some Bash calls return a nonzero exit as a successful hook invocation.
            meta.setdefault("outcome", "succeeded")
            if meta["outcome"] == "succeeded" and tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
                target = args.get("file_path", args.get("notebook_path"))
                if isinstance(target, str):
                    if not target.startswith("/"):
                        target = os.path.normpath(os.path.join(meta["cwd"], target))
                    meta["changedFiles"] = [target]
    return clean({"category": "agent", "action": action, "metadata": meta}) if action else None


if __name__ == "__main__":
    try:
        payload = json.loads(sys.stdin.read(2 * 1024 * 1024))
        event = normalize_hook(payload)
        if event:
            with open("/tmp/periscope-terminal.log", "a") as output:
                fcntl.flock(output, fcntl.LOCK_EX)
                output.write("AGENTGUARD_EVENT " + json.dumps(event) + "\n")
    except (ValueError, TypeError, OSError, AttributeError):
        # Observability must not become an implicit allow/deny decision.
        pass
