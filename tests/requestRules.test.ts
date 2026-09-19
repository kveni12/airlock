import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RequestService } from "../src/request/requestService.js";
import { DEFAULT_REQUEST_RULES, validateRules } from "../src/request/requestRules.js";
import { JsonStore } from "../src/store/jsonStore.js";

let dir: string;
let store: JsonStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "periscope-rules-"));
  store = new JsonStore(path.join(dir, "store.json"));
  await store.init();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("editable request rules", () => {
  it("rejects rules with an invalid regex", () => {
    expect(() => validateRules({ ...DEFAULT_REQUEST_RULES, prohibitionPatterns: ["\\bdo not\\b", "("] })).toThrow(/prohibitionPatterns\[1\].*regular expression/);
    expect(() => validateRules({ ...DEFAULT_REQUEST_RULES, hedgePatterns: [{ pattern: "[", label: "x" }] })).toThrow(/hedgePatterns\[0\]/);
  });

  it("persists edited rules, bumps the revision and uses them for later analyses", async () => {
    const service = new RequestService(store);
    const before = await service.create({ taskId: "t", rawPrompt: "Refrain from editing the schema. Fix the bug." });
    expect(before.analysis.explicitConstraints).toHaveLength(0);
    expect(before.analysis.rulesRevision).toBe(0);

    const updated = await service.updateRules({
      ...DEFAULT_REQUEST_RULES,
      prohibitionPatterns: [...DEFAULT_REQUEST_RULES.prohibitionPatterns, "\\brefrain from\\b"]
    });
    expect(updated.revision).toBe(1);

    const after = await service.create({ taskId: "t", rawPrompt: "Refrain from editing the schema. Fix the bug." });
    expect(after.analysis.explicitConstraints.map((c) => c.text)).toEqual(["Refrain from editing the schema"]);
    expect(after.analysis.explicitlyForbiddenResources.map((r) => r.resource)).toContain("schema");
    expect(after.analysis.rulesRevision).toBe(1);

    const reloaded = new RequestService(store);
    expect((await reloaded.getRules()).revision).toBe(1);
  });

  it("previews against unsaved rules without persisting them", async () => {
    const service = new RequestService(store);
    const preview = await service.preview("Please steer clear of infra.", {
      ...DEFAULT_REQUEST_RULES,
      prohibitionPatterns: ["\\bsteer clear of\\b"]
    });
    expect(preview.explicitConstraints).toHaveLength(1);
    expect((await service.getRules()).revision).toBe(0);
    await expect(service.preview("x", { ...DEFAULT_REQUEST_RULES, imperativeVerbs: [1] })).rejects.toThrow(/imperativeVerbs/);
  });

  it("manual mode keeps the human-edited lists and does not re-parse the prompt", async () => {
    const service = new RequestService(store);
    const { request, analysis } = await service.create({
      taskId: "t",
      rawPrompt: "Fix the login bug and add a test. Do not touch the database.",
      analysisMode: "manual",
      requestedObjectives: ["Fix the login bug"],
      explicitConstraints: ["Do not touch the database", "Keep the API stable"]
    });
    expect(request.rawPrompt).toBe("Fix the login bug and add a test. Do not touch the database.");
    expect(analysis.objectives.map((o) => [o.text, o.source])).toEqual([["Fix the login bug", "caller"]]);
    expect(analysis.explicitConstraints.map((c) => c.text)).toEqual(["Do not touch the database", "Keep the API stable"]);
    expect(analysis.explicitlyForbiddenResources.map((r) => r.resource)).toContain("database");
  });

  it("resets to defaults with a new revision", async () => {
    const service = new RequestService(store);
    await service.updateRules({ ...DEFAULT_REQUEST_RULES, imperativeVerbs: [] });
    const reset = await service.resetRules();
    expect(reset.revision).toBe(2);
    expect(reset.imperativeVerbs).toEqual(DEFAULT_REQUEST_RULES.imperativeVerbs);
  });
});
