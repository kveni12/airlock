import { expect, it } from "vitest";
import { attemptsFor, commandsFor, reportedChangedFiles } from "../frontend/lib/agent-actions.js";
import type { AgentEvent } from "../frontend/lib/contracts.js";
const event = (metadata: Record<string, unknown>, action = "tool_call"): AgentEvent => ({ id: "e", runId: "r", taskId: "t", agentId: "a", timestamp: "now", category: "agent", action, metadata });
const permissions = { filesystem: [{ path: "/workspace", access: "read" as const }, { path: "/workspace/src", access: "read_write" as const }] };
it("recognizes Claude file tools and Bash working directories", () => {
  expect(attemptsFor(event({ tool: "Edit", arguments: { file_path: "infra/prod.tf" }, cwd: "/workspace" }), permissions)[0]).toMatchObject({ action: "Write", path: "/workspace/infra/prod.tf", access: "Read only" });
  expect(commandsFor(event({ tool: "Bash", arguments: { command: "cat file.ts" }, cwd: "/workspace/src" }))[0]).toMatchObject({ command: "cat file.ts", workdir: "/workspace/src" });
});
it("formats nested exec without evaluating code and identifies scoped attempts", () => {
  const e = event({ arguments: 'text(await tools.exec_command({"cmd":"cat README.md; echo hello >> infra/prod.tf","workdir":"/workspace","sandbox_permissions":"require_escalated"}));' });
  expect(commandsFor(e)).toEqual([{ command: "cat README.md; echo hello >> infra/prod.tf", workdir: "/workspace", escalation: true }]);
  expect(attemptsFor(e, permissions)).toEqual([
    { action: "Read", path: "/workspace/README.md", access: "Read only", outside: false },
    { action: "Write", path: "/workspace/infra/prod.tf", access: "Read only", outside: false }
  ]);
  expect(attemptsFor(event({ arguments: { cmd: "cat ../private.txt" } }), permissions)[0].outside).toBe(true);
});
it("does not count editor events, failed patches, or merely requested writes as agent edits", () => {
  const manual = { ...event({}), category: "filesystem" as const, action: "write", resource: "/workspace/infra/prod.tf" };
  const attempted = event({ arguments: { cmd: "echo x > infra/prod.tf" } });
  const failed = event({ outcome: "denied", changedFiles: ["infra/prod.tf"] }, "tool_result");
  const success = event({ outcome: "succeeded", changedFiles: ["src/a.txt", "../outside"] }, "tool_result");
  expect([...reportedChangedFiles([manual, attempted, failed, success])]).toEqual(["src/a.txt"]);
});
it("handles literal patches and leaves dynamic scripts unattributed", () => {
  expect(attemptsFor(event({ arguments: "*** Begin Patch\n*** Update File: infra/prod.tf\n*** End Patch" }), permissions)[0].action).toBe("Write");
  expect(attemptsFor(event({ arguments: { cmd: "cat $FILE" } }), permissions)).toEqual([]);
});
it("keeps working directories and escalation flags tied to each nested command", () => {
  const e = event({ arguments: 'await tools.exec_command({"cmd":"cat README.md","workdir":"/workspace"}); await tools.exec_command({"cmd":"cat private.txt","workdir":"/other","sandbox_permissions":"require_escalated"});' });
  expect(commandsFor(e)).toEqual([{ command: "cat README.md", workdir: "/workspace", escalation: false }, { command: "cat private.txt", workdir: "/other", escalation: true }]);
});
