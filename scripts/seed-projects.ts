/**
 * Seeds a few sample projects (the bundled fixture repos with sensible least-privilege scopes)
 * so the Projects page has something to open. Idempotent: matched by name, existing projects are
 * updated in place. Set AGENTGUARD_RUNTIME_PROVIDER to pick the runtime (defaults to docker).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "../src/store/jsonStore.js";
import { ProjectService } from "../src/projects/projectService.js";
import type { ProjectInput, RuntimeProviderKind } from "../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = ((): RuntimeProviderKind => {
  const configured = process.env.AGENTGUARD_RUNTIME_PROVIDER;
  return configured === "lima" || configured === "process" ? configured : "docker";
})();

const fixture = (name: string) => path.relative(process.cwd(), path.join(root, "fixtures", name)) || ".";

const SAMPLE_PROJECTS: ProjectInput[] = [
  {
    name: "Auth service (intent demo)",
    repoPath: fixture("intent-demo-repo"),
    branch: "main",
    agentKind: "claude_code",
    runtime,
    notes: "Session-handling fixes only. Infrastructure and dependency manifests stay read-only; nothing may reach the network.",
    scope: {
      folders: [
        { path: "src/auth", access: "read_write" },
        { path: "tests/auth", access: "read_write" },
        { path: "src", access: "read" },
        { path: "package.json", access: "read" }
      ],
      hosts: ["api.anthropic.com"],
      secrets: ["ANTHROPIC_API_KEY"],
      mcpServers: [],
      tools: ["npm test"]
    }
  },
  {
    name: "Widget library (Codex)",
    repoPath: fixture("demo-repo"),
    agentKind: "codex",
    runtime,
    notes: "Small library with a test script. Whole src tree writable, tests read-only so the agent cannot weaken them.",
    scope: {
      folders: [
        { path: "src", access: "read_write" },
        { path: "test.js", access: "read" }
      ],
      hosts: ["api.openai.com"],
      secrets: ["OPENAI_API_KEY"],
      mcpServers: [],
      tools: ["node test.js"]
    }
  },
  {
    name: "Docs-only sandbox",
    repoPath: fixture("phase2-demo-repo"),
    runtime,
    notes: "Least-privilege template: README editable, everything else read-only, no network, no secrets.",
    scope: {
      folders: [{ path: "README.md", access: "read_write" }],
      hosts: [],
      secrets: [],
      mcpServers: [],
      tools: []
    }
  }
];

async function main(): Promise<void> {
  const store = new JsonStore();
  await store.init();
  const projects = new ProjectService(store);
  const existing = await projects.list();
  for (const sample of SAMPLE_PROJECTS) {
    const match = existing.find((project) => project.name === sample.name);
    const saved = match ? await projects.update(match.id, sample) : await projects.create(sample);
    console.log(`${match ? "updated" : "created"} ${saved?.id ?? "?"}  ${sample.name}  (${sample.repoPath}, ${sample.runtime})`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
