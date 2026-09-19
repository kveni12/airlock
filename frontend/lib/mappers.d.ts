import type { DashboardSnapshot, PermissionSnapshot, RunStatus } from "./contracts";
export function isRunActive(status: RunStatus): boolean;
export function statusLabel(status: string): string;
export function summarizeSnapshot(snapshot: DashboardSnapshot): { activeAgents: number; policyAlerts: number; filesChanged: number; recordedEvents: number };
export function permissionCount(permissions: PermissionSnapshot): number;
