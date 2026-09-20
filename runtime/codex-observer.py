"""Emit selected public Codex session records; never read auth or reasoning files."""
import json
import os
import pathlib
import re
import sys
import time

LIMIT = 12000
SECRET = re.compile(r"secret|token|password|passwd|api.?key|credential", re.I)
VALUES = [v for k, v in os.environ.items() if SECRET.search(k) and len(v) >= 4]


def clean(value):
    if isinstance(value, dict):
        return {k: "[REDACTED]" if SECRET.search(k) else clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value[:100]]
    if not isinstance(value, str):
        return value
    truncated = len(value) > LIMIT
    value = value[:LIMIT]
    for secret in VALUES:
        value = value.replace(secret, "[REDACTED]")
    value = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----", "[REDACTED]", value)
    value = re.sub(r"(?i)Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", value)
    value = re.sub(r"(?i)(\b[\w-]{0,80}(?:token|password|secret|api_key)[\w-]{0,80}[\"']?\s*[:=]\s*)[^\s,}]+", r"\1[REDACTED]", value)
    return value + ("\n[truncated]" if truncated else "")


def result_summary(output):
    # Extract outcome markers only, not arbitrary command output/file contents.
    if isinstance(output, str):
        try:
            parsed = json.loads(output)
        except ValueError:
            parsed = output
    else:
        parsed = output
    def texts(value):
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return "\n".join(texts(v) for v in value[:100])
        if isinstance(value, dict):
            return "\n".join(texts(v) for k, v in value.items() if k in ("text", "output", "stdout", "stderr", "message", "content", "error"))
        return ""
    text = texts(parsed)[:100000]
    result = {}
    if isinstance(parsed, dict):
        code = parsed.get("exit_code", parsed.get("exitCode"))
        if isinstance(code, int):
            result["exitCode"] = code
    match = re.search(r"(?:Process exited with code|exit code|exited with code)[: ]+(-?\d+)", text, re.I)
    if match:
        result["exitCode"] = int(match.group(1))
    reasons = []
    for pattern, reason in [(r"Read-only file system|\bEROFS\b", "Read-only filesystem"), (r"Permission denied|\bEACCES\b", "Permission denied"), (r"Operation not permitted|\bEPERM\b", "Operation not permitted"), (r"approval.{0,30}(?:denied|rejected)|rejected.{0,30}approval", "Approval rejected")]:
        if re.search(pattern, text, re.I):
            reasons.append(reason)
    if reasons:
        result.update(outcome="denied", reasons=reasons)
    elif result.get("exitCode") is not None:
        result["outcome"] = "succeeded" if result["exitCode"] == 0 else "failed"
    if "Success. Updated the following files:" in text:
        files = re.findall(r"^[AMD] (.+)$", text, re.M)
        if files:
            result.update(changedFiles=files[:100], outcome="succeeded")
    return result


def normalize(record, calls=None):
    p = record.get("payload", {})
    t = p.get("type")
    meta = {"source": "codex_session", "recordedAt": record.get("timestamp")}
    action = None
    if record.get("type") == "response_item":
        if t == "message" and p.get("role") in ("user", "assistant") and p.get("phase") not in ("analysis", "summary"):
            text = "\n".join(c.get("text", "") for c in p.get("content", []) if c.get("type") in ("input_text", "output_text", "text"))
            # Initial workspace/instruction context is not a user conversation turn.
            if not text or text.lstrip().startswith(("<environment_context>", "<permissions instructions>", "# AGENTS.md", "<INSTRUCTIONS>")):
                return None
            action = "message"
            meta.update(role=p["role"], text=text)
        elif t in ("function_call", "custom_tool_call"):
            action = "tool_call"
            args = p.get("arguments", p.get("input", ""))
            try:
                args = json.loads(args)
            except (ValueError, TypeError):
                pass
            meta.update(tool=p.get("name", "tool"), callId=p.get("call_id"), arguments=args)
            if calls is not None and p.get("call_id"):
                calls[p["call_id"]] = {"name": p.get("name", ""), "args": args}
        elif t in ("function_call_output", "custom_tool_call_output"):
            action = "tool_result"
            # Do not copy arbitrary file contents or credentials from tool output.
            summary = result_summary(p.get("output", ""))
            call = (calls or {}).get(p.get("call_id"), {})
            patch_call = "apply_patch" in call.get("name", "") or (isinstance(call.get("args"), str) and "tools.apply_patch(" in call["args"])
            if not patch_call:
                summary.pop("changedFiles", None)
            meta.update(callId=p.get("call_id"), **summary)
        elif t == "web_search_call":
            action = "tool_call"
            meta.update(tool="web_search", callId=p.get("id"), arguments=p.get("action", {}), status=p.get("status"))
    elif record.get("type") == "event_msg" and t == "item_completed":
        item = p.get("item", {})
        if item.get("type") in ("file_change", "fileChange") and item.get("status") == "completed":
            action = "tool_result"
            changes = item.get("changes", [])
            files = list(changes.keys()) if isinstance(changes, dict) else [c.get("path") for c in changes if isinstance(c, dict) and c.get("path")]
            meta.update(callId=item.get("id"), changedFiles=files[:100], outcome="succeeded")
        elif item.get("type") in ("webSearch", "web_search"):
            action = "tool_call"
            meta.update(tool="web_search", callId=item.get("id"), arguments={"query": item.get("query"), "action": item.get("action")})
    if action:
        return clean({"category": "agent", "action": action, "metadata": meta})
    return None


def poll(root, cursors, seen, calls=None):
    for file in sorted(root.rglob("*.jsonl")):
        if file.is_symlink():
            continue
        offset = cursors.get(str(file), 0)
        try:
            with file.open("rb") as stream:
                if file.stat().st_size < offset:
                    offset = 0
                stream.seek(offset)
                for _ in range(500):
                    start = stream.tell()
                    line = stream.readline(2 * 1024 * 1024)
                    if not line or not line.endswith(b"\n"):
                        stream.seek(start)
                        break
                    try:
                        event = normalize(json.loads(line), calls)
                        if event:
                            key = (event["action"], event["metadata"].get("callId"))
                            if key[1] and key in seen:
                                continue
                            if key[1]:
                                seen.add(key)
                            print("AGENTGUARD_EVENT " + json.dumps(event), flush=True)
                    except (ValueError, TypeError, AttributeError):
                        pass
                cursors[str(file)] = stream.tell()
        except OSError:
            continue


if __name__ == "__main__":
    root = pathlib.Path("/tmp/.codex/sessions")
    cursors, seen, calls = {}, set(), {}
    print('AGENTGUARD_EVENT {"category":"agent","action":"message","metadata":{"source":"codex_session","role":"notice","text":"Codex action logging connected. Tool output and private reasoning are not recorded."}}', flush=True)
    while True:
        poll(root, cursors, seen, calls)
        if pathlib.Path("/tmp/periscope-demo-exit").exists():
            break
        time.sleep(0.5)
