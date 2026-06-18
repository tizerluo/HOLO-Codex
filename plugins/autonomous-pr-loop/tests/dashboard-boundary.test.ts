import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("dashboard boundaries", () => {
  it("does not import storage write APIs from UI code", () => {
    for (const file of uiSourceFiles("plugins/autonomous-pr-loop/ui/src")) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/core\/storage|SqliteAgentLoopStorage|writeGate|createRun|updateRunStatus/);
    }
  });

  it("keeps dashboard sections as real page modules", () => {
    const sectionFiles = [
      "agent-timeline/AgentTimelineView.tsx",
      "artifact-viewer/ArtifactViewer.tsx",
      "dry-run-preview/DryRunPreview.tsx",
      "event-ledger/EventLedger.tsx",
      "gate-center/GateCenter.tsx",
      "mission-control/MissionControl.tsx",
      "notifications/NotificationsView.tsx",
      "plan-navigator/PlanNavigator.tsx",
      "policy-config/PolicyConfig.tsx",
      "pr-inbox/PrInbox.tsx",
      "recovery-center/RecoveryCenter.tsx",
      "scope-guard/ScopeGuard.tsx",
      "worker-runs/WorkerRuns.tsx"
    ];

    for (const file of sectionFiles) {
      const source = readFileSync(join(process.cwd(), "plugins/autonomous-pr-loop/ui/src/pages", file), "utf8");
      expect(source).toMatch(/export function \w+/);
      expect(source.trim()).not.toMatch(/^export \{ .* \} from /);
    }
  });

  it("keeps reusable dashboard primitives in components", () => {
    const componentFiles = [
      "Collapsible.tsx",
      "List.tsx",
      "MetricRow.tsx",
      "ResponsiveTable.tsx",
      "TopMetric.tsx"
    ];

    for (const file of componentFiles) {
      const source = readFileSync(join(process.cwd(), "plugins/autonomous-pr-loop/ui/src/components", file), "utf8");
      expect(source).toMatch(/export (function|interface) \w+/);
    }

    const parts = readFileSync(join(process.cwd(), "plugins/autonomous-pr-loop/ui/src/pages/CommandCenterParts.tsx"), "utf8");
    expect(parts).not.toMatch(/export function (Collapsible|List|MetricRow|ResponsiveTable|TopMetric)/);
  });
});

function uiSourceFiles(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return uiSourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}
