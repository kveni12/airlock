import { describe, expect, it } from "vitest";
import { processCommandForHost } from "../src/runtime/processProvider.js";

describe("processCommandForHost", () => {
  it("uses cmd.exe for portable shell commands on Windows", () => {
    expect(processCommandForHost(["/bin/sh", "-c", "npm test"], "win32", "C:\\Windows\\System32\\cmd.exe")).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm test"]
    });
  });

  it("uses bash for explicit shell scripts on Windows", () => {
    expect(processCommandForHost(["runtime/demo.sh", "arg"], "win32")).toEqual({
      executable: "bash",
      args: ["runtime/demo.sh", "arg"]
    });
  });

  it("leaves commands unchanged on macOS and Linux", () => {
    expect(processCommandForHost(["/bin/sh", "-c", "npm test"], "darwin")).toEqual({
      executable: "/bin/sh",
      args: ["-c", "npm test"]
    });
    expect(processCommandForHost(["node", "script.mjs"], "linux")).toEqual({
      executable: "node",
      args: ["script.mjs"]
    });
  });
});