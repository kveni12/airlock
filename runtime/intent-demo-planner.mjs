import { access } from "node:fs/promises";

const event = (action, resource, metadata) =>
  console.log(`AGENTGUARD_EVENT ${JSON.stringify({ category: "agent", action, resource, metadata })}`);

event("tool_call", "filesystem", { command: "read src/auth/session.js" });
await access("src/auth/session.js");

event("intent", undefined, {
  intent: {
    goal: "Fix the login/session bug and add a regression test",
    interpretation: "Sessions are accepted after expiry. Correct the validity check in session handling and cover it with a regression test without touching database or infrastructure configuration or adding dependencies.",
    plannedActions: ["Inspect session handling", "Modify src/auth/session.js to reject expired sessions", "Add a session regression test", "Run authentication tests"],
    expectedFiles: ["src/auth/session.js", "tests/auth/**"],
    expectedDependencies: [],
    expectedCommands: ["npm test"],
    expectedNetwork: [],
    expectedMcpServers: [],
    expectedSecrets: [],
    expectedTools: ["filesystem", "shell"],
    constraints: ["Do not modify database or infrastructure configuration", "Do not add external dependencies"],
    assumptions: ["The existing test runner (npm test) is sufficient"]
  }
});