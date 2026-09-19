export type ReviewSeverity = "critical" | "high" | "medium" | "low";
export type ReviewStatus = "open" | "in_review" | "resolved";

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  title: string;
  file: string;
  line: number;
  explanation: string;
  recommendation: string;
}

export interface ReviewTask {
  id: string;
  title: string;
  repository: string;
  branch: string;
  author: string;
  status: ReviewStatus;
  riskScore: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  submittedAt: string;
  summary: string;
  findings: ReviewFinding[];
  diff: string;
}

export const reviewTasks: ReviewTask[] = [
  {
    id: "oauth-refresh-flow",
    title: "Add OAuth refresh-token rotation",
    repository: "agent-guard/web-api",
    branch: "feat/oauth-refresh",
    author: "code-agent-03",
    status: "in_review",
    riskScore: 82,
    filesChanged: 6,
    additions: 148,
    deletions: 32,
    submittedAt: "2026-09-19T13:42:00-04:00",
    summary: "Adds refresh-token rotation and session renewal. The prototype reviewer flags a token logging path and a missing replay guard.",
    findings: [
      { id: "oauth-1", severity: "critical", title: "Refresh token can reach application logs", file: "src/auth/oauth.ts", line: 118, explanation: "The failure branch includes the raw provider response in structured logs. That response can contain a refresh token.", recommendation: "Log an error code and request identifier only. Redact provider payloads before they enter the logger." },
      { id: "oauth-2", severity: "high", title: "Rotation is not protected against replay", file: "src/auth/session-store.ts", line: 74, explanation: "The previous token remains valid until its natural expiration, allowing the same refresh credential to be reused.", recommendation: "Invalidate the prior token atomically when storing the replacement and reject an already-consumed token." }
    ],
    diff: `diff --git a/src/auth/oauth.ts b/src/auth/oauth.ts\n@@ -112,6 +112,9 @@ export async function refreshSession(token) {\n+  logger.error({ response: providerResponse }, "OAuth refresh failed");\n+  return rotateToken(providerResponse.refresh_token);`
  },
  {
    id: "billing-webhook",
    title: "Retry failed billing webhooks",
    repository: "agent-guard/payments",
    branch: "fix/webhook-retries",
    author: "backend-agent-07",
    status: "open",
    riskScore: 48,
    filesChanged: 3,
    additions: 71,
    deletions: 9,
    submittedAt: "2026-09-19T11:18:00-04:00",
    summary: "Adds exponential retry scheduling for transient payment provider failures.",
    findings: [{ id: "billing-1", severity: "medium", title: "Retry jitter is missing", file: "src/webhooks/retry.ts", line: 41, explanation: "All failed deliveries from the same batch will retry at the same time.", recommendation: "Add bounded random jitter to each calculated retry delay." }],
    diff: `diff --git a/src/webhooks/retry.ts b/src/webhooks/retry.ts\n@@ -36,4 +36,5 @@ export function nextAttempt(attempt) {\n+  return Date.now() + 2 ** attempt * 1000;`
  },
  {
    id: "docs-index",
    title: "Regenerate documentation index",
    repository: "agent-guard/docs",
    branch: "chore/docs-index",
    author: "docs-agent-02",
    status: "resolved",
    riskScore: 12,
    filesChanged: 18,
    additions: 94,
    deletions: 88,
    submittedAt: "2026-09-18T16:05:00-04:00",
    summary: "Updates generated navigation after the runtime guide was reorganized.",
    findings: [],
    diff: `diff --git a/docs/index.json b/docs/index.json\n@@ -1,3 +1,3 @@\n-  "runtime/old-guide"\n+  "runtime/execution-guide"`
  }
];

export function getReviewTask(id: string) {
  return reviewTasks.find((review) => review.id === id);
}
