import { describe, expect, it } from "vitest";
import { Redactor } from "../src/security/redaction.js";

describe("Redactor", () => {
  it("removes secret values from nested telemetry metadata", () => {
    const redactor = new Redactor({
      secretNames: ["GOOGLE_CLIENT_SECRET"],
      secretValues: ["super-secret-value"]
    });

    const sanitized = redactor.sanitize({
      args: ["--token=super-secret-value", "GOOGLE_CLIENT_SECRET=actual"],
      headers: { authorization: "Bearer abc.def.ghi" },
      nested: { apiKey: "12345" }
    });

    expect(JSON.stringify(sanitized)).not.toContain("super-secret-value");
    expect(JSON.stringify(sanitized)).not.toContain("actual");
    expect(JSON.stringify(sanitized)).not.toContain("abc.def.ghi");
    expect(JSON.stringify(sanitized)).not.toContain("12345");
  });
});
