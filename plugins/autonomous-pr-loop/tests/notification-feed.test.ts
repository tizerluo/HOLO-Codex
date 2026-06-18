import { describe, expect, it } from "vitest";
import { deriveNotifications } from "../core/notification-feed.js";
import { withConfigDefaults } from "../core/config.js";

describe("notification feed", () => {
  it("does not upgrade ordinary progress events under blockers_only mode", () => {
    const config = withConfigDefaults({ repoId: "owner/repo", notifyMode: "blockers_only" });
    const notifications = deriveNotifications({
      config,
      events: [{ id: "event", seq: 1, kind: "state_advanced", message: "Progress.", createdAt: "now" }],
      gates: []
    });

    expect(notifications).toHaveLength(0);
  });

  it("explains blocked gate notifications", () => {
    const config = withConfigDefaults({ repoId: "owner/repo" });
    const notifications = deriveNotifications({
      config,
      events: [],
      gates: [{
        id: "gate",
        kind: "policy_violation",
        status: "open",
        message: "Blocked.",
        createdAt: "now"
      }]
    });

    expect(notifications[0]?.severity).toBe("blocked");
    expect(notifications[0]?.reason).toContain("policy");
  });

  it("filters notifications marked read by controller events", () => {
    const config = withConfigDefaults({ repoId: "owner/repo" });
    const notifications = deriveNotifications({
      config,
      events: [{
        id: "event",
        seq: 1,
        kind: "notification_marked_read",
        message: "read",
        payload: { notificationIds: ["gate:gate"] },
        createdAt: "now"
      }],
      gates: [{
        id: "gate",
        kind: "policy_violation",
        status: "open",
        message: "Blocked.",
        createdAt: "now"
      }]
    });

    expect(notifications).toHaveLength(0);
  });

  it("filters notifications dismissed independently from marked read events", () => {
    const config = withConfigDefaults({ repoId: "owner/repo", notifyMode: "all_gates" });
    const notifications = deriveNotifications({
      config,
      events: [{
        id: "event",
        seq: 1,
        kind: "notification_dismissed",
        message: "dismissed",
        payload: { notificationIds: ["longrunning:worker-1:command-1"] },
        createdAt: "now"
      }],
      gates: [],
      workers: [{
        id: "worker-1",
        runId: "run-1",
        type: "implementation",
        backend: "codex-exec",
        status: "running",
        attempt: 1,
        resumeUsed: false,
        startedAt: "2026-06-12T10:00:00.000Z"
      }],
      timelineEntries: [
        timelineEntry("worker_event", "command_execution", "started command_execution", "2026-06-12T10:00:00.000Z", "command-1")
      ],
      now: new Date("2026-06-12T10:02:00.000Z")
    });

    expect(notifications.map((notification) => notification.id)).not.toContain("longrunning:worker-1:command-1");
  });

  it("derives stable full-cycle notifications and respects dismissed ids", () => {
    const config = withConfigDefaults({ repoId: "owner/repo", notifyMode: "all_gates" });
    const notifications = deriveNotifications({
      config,
      events: [],
      gates: [],
      runId: "run-1",
      workers: [{
        id: "worker-1",
        runId: "run-1",
        type: "implementation",
        backend: "codex-exec",
        status: "failed",
        attempt: 1,
        resumeUsed: false,
        startedAt: "2026-06-12T10:00:00.000Z",
        completedAt: "2026-06-12T10:01:00.000Z",
        error: "boom"
      }],
      timelineEntries: [
        timelineEntry("worker_event", "command_execution", "started command_execution", "2026-06-12T10:00:00.000Z", "command-1"),
        timelineEntry("worker_event", "PermissionRequest", "PermissionRequest", "2026-06-12T10:00:30.000Z", "permission-1")
      ],
      mergeReadiness: {
        state: "ready",
        ready: true,
        missingConditions: [],
        evidence: ["ci green"],
        carryoverRecords: []
      },
      now: new Date("2026-06-12T10:02:10.000Z"),
      dismissedIds: new Set(["longrunning:worker-1:command-1"])
    });

    expect(notifications.map((notification) => notification.id)).toEqual(expect.arrayContaining([
      "worker:worker-1:failed",
      "permission:worker-1:permission-1",
      "mergeready:run-1"
    ]));
    expect(notifications.map((notification) => notification.id)).not.toContain("longrunning:worker-1:command-1");
  });

  it("does not show long-running command notifications after the worker reaches terminal status", () => {
    const config = withConfigDefaults({ repoId: "owner/repo", notifyMode: "all_gates" });
    const notifications = deriveNotifications({
      config,
      events: [],
      gates: [],
      workers: [{
        id: "worker-1",
        runId: "run-1",
        type: "implementation",
        backend: "codex-exec",
        status: "succeeded",
        attempt: 1,
        resumeUsed: false,
        startedAt: "2026-06-12T10:00:00.000Z",
        completedAt: "2026-06-12T10:02:00.000Z"
      }],
      timelineEntries: [
        timelineEntry("worker_event", "command_execution", "started command_execution", "2026-06-12T10:00:00.000Z", "command-1")
      ],
      now: new Date("2026-06-12T10:03:00.000Z")
    });

    expect(notifications.map((notification) => notification.id)).not.toContain("longrunning:worker-1:command-1");
  });

  it("does not treat permission denied text as a permission request", () => {
    const config = withConfigDefaults({ repoId: "owner/repo", notifyMode: "all_gates" });
    const notifications = deriveNotifications({
      config,
      events: [],
      gates: [],
      timelineEntries: [
        timelineEntry("worker_event", "command_execution", "permission denied while running command", "2026-06-12T10:00:00.000Z", "command-1")
      ],
      now: new Date("2026-06-12T10:00:10.000Z")
    });

    expect(notifications.map((notification) => notification.id)).not.toContain("permission:worker-1:command-1");
  });
});

function timelineEntry(
  source: "worker_event",
  kind: string,
  title: string,
  occurredAt: string,
  id: string
) {
  return {
    timelineSeq: 1,
    occurredAt,
    cursor: "cursor",
    source,
    kind,
    runId: "run-1",
    workerId: "worker-1",
    title,
    summary: JSON.stringify({ id, startedAt: occurredAt, command: "pnpm test" }),
    createdAt: occurredAt,
    rawRef: { table: "worker_events", id, seq: 1 }
  };
}
