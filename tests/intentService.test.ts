import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IntentService, normalizeDependency, normalizeExpectedFile, normalizeHostname } from "../src/intent/intentService.js";
import { JsonStore } from "../src/store/jsonStore.js";

describe("IntentService", () => {
  it("validates, normalizes, and persists structured intent separately", async () => {
    const harness = await createHarness();
    const intent = await harness.service.create(
      "task_oauth",
      {
        goal: "Add OAuth",
        plannedChanges: ["Add provider"],
        expectedFiles: ["/workspace/src/auth/**", "./tests/auth.test.ts"],
        expectedDependencies: ["Passport_Google.OAuth20"],
        expectedNetwork: ["https://OAuth.GoogleApis.com/path"],
        expectedMcpServers: ["GitHub"],
        expectedSecrets: ["GOOGLE_CLIENT_SECRET"],
        constraints: ["Do not modify infrastructure"]
      },
      { agentId: "builder", agentType: "codex" }
    );

    expect(intent.expectedFiles).toEqual(["src/auth/**", "tests/auth.test.ts"]);
    expect(intent.expectedDependencies).toEqual(["passport-google-oauth20"]);
    expect(intent.expectedNetwork).toEqual(["oauth.googleapis.com"]);
    expect(intent.expectedMcpServers).toEqual(["github"]);
    expect(await harness.store.getIntent(intent.id)).toEqual(intent);
    await harness.cleanup();
  });

  it("rejects malformed generated intent", async () => {
    const harness = await createHarness();
    expect(() => harness.service.parseGeneratedOutput("not-json")).toThrow("not valid JSON");
    expect(() =>
      harness.service.parseGeneratedOutput({ goal: "Missing arrays", plannedChanges: "wrong" })
    ).toThrow("intent.plannedChanges");
    await harness.cleanup();
  });

  it("accepts the extended intent shape and keeps plannedChanges/plannedActions in sync", async () => {
    const harness = await createHarness();
    const intent = await harness.service.create(
      "task_login",
      {
        goal: "Fix login failures caused by expired sessions",
        interpretation: "Correct session validation without changing database behavior.",
        plannedActions: ["Inspect session validation", "Add regression test", "Run authentication tests"],
        expectedFiles: ["src/auth/session.ts"],
        expectedCommands: ["npm test"],
        expectedTools: ["filesystem", "shell"],
        assumptions: ["Sessions expire after 24h"],
        constraints: ["Do not modify the database"]
      },
      { agentId: "planner", agentType: "codex", requestId: "req_1", planningRunId: "run_plan" }
    );
    expect(intent.plannedChanges).toEqual(intent.plannedActions);
    expect(intent.plannedActions).toHaveLength(3);
    expect(intent.expectedCommands).toEqual(["npm test"]);
    expect(intent.expectedTools).toEqual(["filesystem", "shell"]);
    expect(intent.assumptions).toEqual(["Sessions expire after 24h"]);
    expect(intent.requestId).toBe("req_1");
    expect(intent.planningRunId).toBe("run_plan");
    expect(() =>
      harness.service.parseGeneratedOutput({ goal: "x", plannedActions: ["a"], expectedFiles: [], constraints: [], expectedCommands: "npm test" })
    ).toThrow("intent.expectedCommands");
    await harness.cleanup();
  });

  it("normalizes expected resources deterministically", () => {
    expect(normalizeExpectedFile("/workspace/src/auth/**")).toBe("src/auth/**");
    expect(normalizeDependency("My_Package.Name")).toBe("my-package-name");
    expect(normalizeHostname("HTTPS://API.GITHUB.COM/path")).toBe("api.github.com");
    expect(() => normalizeExpectedFile("../secrets")).toThrow("Invalid expected file path");
  });
});

async function createHarness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentguard-intent-"));
  const store = new JsonStore(path.join(directory, "store.json"));
  await store.init();
  return {
    store,
    service: new IntentService(store),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}
