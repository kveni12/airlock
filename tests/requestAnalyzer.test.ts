import { describe, expect, it } from "vitest";
import { RequestAnalyzer } from "../src/request/requestAnalyzer.js";
import type { HumanRequest } from "../src/types.js";

describe("RequestAnalyzer", () => {
  const analyzer = new RequestAnalyzer();

  it("extracts explicit objectives and constraints from the raw prompt", () => {
    const analysis = analyzer.analyze(request("Fix the login bug. Don't modify the database."));
    expect(analysis.objectives.map((item) => item.text)).toEqual(["Fix the login bug"]);
    expect(analysis.explicitConstraints.map((item) => item.text)).toEqual(["Do not modify the database"]);
    expect(analysis.explicitlyForbiddenResources.map((item) => item.category)).toEqual(["database"]);
    expect(analysis.explicitlyRequestedResources).toEqual([]);
    expect(analysis.ambiguities).toEqual([]);
    expect(analysis.analyzer).toBe("deterministic");
  });

  it("splits compound objectives and keeps forbidden resources per category", () => {
    const analysis = analyzer.analyze(
      request(
        "Fix the login/session bug and add a regression test. Do not modify database or infrastructure configuration. Do not add external dependencies."
      )
    );
    expect(analysis.objectives.map((item) => item.text)).toEqual(["Fix the login/session bug", "add a regression test"]);
    expect(analysis.explicitConstraints).toHaveLength(2);
    const forbidden = new Set(analysis.explicitlyForbiddenResources.map((item) => item.category));
    expect(forbidden).toEqual(new Set(["database", "infrastructure", "configuration", "dependencies"]));
    expect(analysis.explicitlyRequestedResources.map((item) => item.category)).toContain("tests");
  });

  it("never turns a missing mention into an explicit prohibition", () => {
    const analysis = analyzer.analyze(request("Fix the login bug."));
    expect(analysis.explicitConstraints).toEqual([]);
    expect(analysis.explicitlyForbiddenResources).toEqual([]);
    expect(analysis.inferredExpectations.length).toBeGreaterThan(0);
    expect(analysis.inferredExpectations.every((item) => item.provenance === "inferred")).toBe(true);
    expect(analysis.objectives.every((item) => item.provenance === "explicit")).toBe(true);
  });

  it("records ambiguities for hedged or vague objectives", () => {
    const analysis = analyzer.analyze(request("Clean up the auth code or maybe the session stuff if necessary."));
    expect(analysis.ambiguities.length).toBeGreaterThanOrEqual(2);
    expect(analyzer.analyze(request("   ")).ambiguities).toContain("no explicit objective could be identified in the request");
  });

  it("merges caller-supplied constraints and objectives as explicit statements", () => {
    const analysis = analyzer.analyze({
      ...request("Fix the login bug."),
      explicitConstraints: ["Do not touch billing"],
      requestedObjectives: ["Keep the API stable"]
    });
    expect(analysis.explicitConstraints).toEqual([
      { text: "Do not touch billing", provenance: "explicit", source: "caller" }
    ]);
    expect(analysis.objectives.at(-1)).toEqual({ text: "Keep the API stable", provenance: "explicit", source: "caller" });
  });
});

function request(rawPrompt: string): HumanRequest {
  return { id: "req_test", taskId: "task_test", rawPrompt, createdAt: new Date().toISOString() };
}
