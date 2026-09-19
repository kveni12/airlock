import { describe, expect, it } from "vitest";
import type { SandboxOutput } from "../src/runtime/sandboxProvider.js";
import { LineDecoder } from "../src/telemetry/lineDecoder.js";

describe("LineDecoder", () => {
  it("preserves line order across arbitrary chunks and flushes the tail", () => {
    const output: SandboxOutput[] = [];
    const decoder = new LineDecoder("stdout", (line) => output.push(line));

    decoder.write("first\nsec");
    decoder.write("ond\r\nthird");
    decoder.flush();

    expect(output).toEqual([
      { stream: "stdout", line: "first" },
      { stream: "stdout", line: "second" },
      { stream: "stdout", line: "third" }
    ]);
  });

  it("bounds lines that never terminate", () => {
    const output: SandboxOutput[] = [];
    const decoder = new LineDecoder("stderr", (line) => output.push(line), 24);

    decoder.write("012345678901234567890123456789");

    expect(output).toHaveLength(1);
    expect(Buffer.byteLength(output[0].line)).toBeLessThanOrEqual(24);
    expect(output[0].line).toContain("[truncated]");
  });
});
