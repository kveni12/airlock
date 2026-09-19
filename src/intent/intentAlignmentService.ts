import { RequestIntentAnalyzer } from "../analysis/requestIntentAnalyzer.js";
import { FindingService } from "../findings/findingService.js";
import { JsonStore } from "../store/jsonStore.js";
import type { AgentIntent, Finding, IntentAlignment } from "../types.js";
import { IntentService } from "./intentService.js";

export interface IntentAlignmentResult {
  intent: AgentIntent;
  alignment: IntentAlignment;
  findings: Finding[];
}

/** Runs request ↔ intent comparison, persists findings, and records the pre-execution decision on the intent. */
export class IntentAlignmentService {
  private readonly analyzer = new RequestIntentAnalyzer();

  constructor(
    private readonly store: JsonStore,
    private readonly intents: IntentService,
    private readonly findings: FindingService
  ) {}

  async analyze(intentId: string): Promise<IntentAlignmentResult> {
    const intent = await this.intents.get(intentId);
    if (!intent) throw new Error(`Intent not found: ${intentId}`);
    if (!intent.requestId) throw new Error(`Intent ${intentId} is not linked to a human request`);
    const request = await this.store.getRequest(intent.requestId);
    if (!request) throw new Error(`Request not found: ${intent.requestId}`);
    const analysis = await this.store.getRequestAnalysis(request.id);
    if (!analysis) throw new Error(`Request analysis not found for ${request.id}`);

    const result = this.analyzer.analyze(request, analysis, intent);
    const created: Finding[] = [];
    for (const draft of result.findings) created.push(await this.findings.create(draft));

    const alignment: IntentAlignment = {
      status: result.status,
      findingIds: created.map((finding) => finding.id),
      analyzedAt: new Date().toISOString()
    };
    const updated = await this.intents.recordAlignment(intentId, alignment);
    return { intent: updated, alignment, findings: created };
  }

  async findingsFor(intentId: string): Promise<Finding[]> {
    return (await this.store.listFindings()).filter(
      (finding) => finding.source === "request_intent_comparison" && finding.evidence?.intentId === intentId
    );
  }

  /** Pre-execution findings are created before a run exists; link them once the intent is attached. */
  async attachFindingsToRun(intentId: string, runId: string): Promise<void> {
    for (const finding of await this.findingsFor(intentId)) {
      if (!finding.runId) await this.store.updateFinding(finding.id, { runId });
    }
  }
}
