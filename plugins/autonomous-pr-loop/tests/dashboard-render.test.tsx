/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../ui/src/app.js";
import { createDashboardApi, storedDashboardToken, type AgentTimelineEntry, type DashboardApi, type MissionControlData, type WorkflowBoard, type WorkflowStageId } from "../ui/src/api.js";
import { dashboardFixtureNames } from "../ui/src/fixtures.js";
import { CommandCenter, decodeBase64Preview } from "../ui/src/pages/CommandCenter.js";
import { summarizeRawMessage } from "../ui/src/pages/CommandCenterParts.js";
import { MissionControl } from "../ui/src/pages/mission-control/MissionControl.js";
import { normalizeThemeSetting, readStoredThemeSetting, resolveEffectiveTheme } from "../ui/src/theme.js";

describe("dashboard render", () => {
  beforeEach(() => {
    installLocalStorage();
    window.localStorage.setItem("agent-loop-dashboard-locale", "en-US");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setViewportWidth(1024);
    window.sessionStorage.clear();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    window.history.replaceState({}, "", "/");
  });

  it("defaults to Chinese and switches dashboard language locally", async () => {
    window.localStorage.clear();
    render(<App api={apiWithRepoLocale("zh-CN")} initialData={fixture("RUNNING")} />);

    expect(await screen.findByRole("heading", { name: "任务控制台" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("语言"), { target: { value: "en-US" } });

    expect(await screen.findByRole("heading", { name: "Mission Control" })).toBeTruthy();
    expect(window.localStorage.getItem("agent-loop-dashboard-locale")).toBe("en-US");
  });

  it("prefers localStorage over repo locale and uses browser locale through system", async () => {
    window.localStorage.setItem("agent-loop-dashboard-locale", "zh-CN");
    render(<App api={apiWithRepoLocale("en-US")} initialData={fixture("RUNNING")} />);
    expect(screen.getByRole("heading", { name: "任务控制台" })).toBeTruthy();

    cleanup();
    installLocalStorage();
    window.localStorage.setItem("agent-loop-dashboard-locale", "system");
    Object.defineProperty(window.navigator, "languages", {
      configurable: true,
      value: ["en-US"]
    });
    render(<App api={apiWithRepoLocale(undefined)} initialData={fixture("RUNNING")} />);
    expect(screen.getByRole("heading", { name: "Mission Control" })).toBeTruthy();
  });

  it("shows a token login screen before creating a live dashboard client", () => {
    window.localStorage.clear();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Dashboard token required" })).toBeTruthy();
    expect(screen.getByLabelText("Dashboard token")).toBeTruthy();
  });

  it("uses the runtime dashboard token before showing the login screen", async () => {
    window.localStorage.setItem("agent-loop-dashboard-token", "stale-token");
    window.__AGENT_LOOP_DASHBOARD_TOKEN__ = "runtime-token";
    const fetchMock = vi.fn(async (path: string) => new Response(JSON.stringify(liveDashboardResponse(path)), {
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Mission Control" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Dashboard token required" })).toBeNull();
    expect(window.localStorage.getItem("agent-loop-dashboard-token")).toBe("runtime-token");
    expect(window.__AGENT_LOOP_DASHBOARD_TOKEN__).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/mission-control", {
      headers: { accept: "application/json" }
    });
  });

  it("normalizes and resolves dashboard theme settings", () => {
    expect(normalizeThemeSetting("light")).toBe("light");
    expect(normalizeThemeSetting("dark")).toBe("dark");
    expect(normalizeThemeSetting("system")).toBe("system");
    expect(normalizeThemeSetting("solarized")).toBeUndefined();
    expect(resolveEffectiveTheme(undefined, true)).toBe("dark");
    expect(resolveEffectiveTheme(undefined, false)).toBe("light");
    expect(resolveEffectiveTheme("light", true)).toBe("light");
    expect(resolveEffectiveTheme("dark", false)).toBe("dark");

    window.localStorage.setItem("agent-loop-dashboard-theme", "dark");
    expect(readStoredThemeSetting()).toBe("dark");
    window.localStorage.setItem("agent-loop-dashboard-theme", "solarized");
    expect(readStoredThemeSetting()).toBeUndefined();
  });

  it("applies and persists dashboard theme locally", async () => {
    installMatchMedia(false);
    render(<App api={noopApi()} initialData={fixture("RUNNING")} />);

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(window.localStorage.getItem("agent-loop-dashboard-theme")).toBe("dark");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(window.localStorage.getItem("agent-loop-dashboard-locale")).toBe("en-US");
  });

  it("sets the saved theme before the React bundle loads", () => {
    const html = readFileSync("plugins/autonomous-pr-loop/ui/index.html", "utf8");

    expect(html.indexOf("agent-loop-dashboard-theme")).toBeGreaterThan(-1);
    expect(html.indexOf("document.documentElement.dataset.theme")).toBeGreaterThan(-1);
    expect(html.indexOf("agent-loop-dashboard-theme")).toBeLessThan(html.indexOf("/src/main.tsx"));
  });

  it("updates system theme when browser preference changes", async () => {
    const media = installMatchMedia(false);
    render(<App api={noopApi()} initialData={fixture("RUNNING")} />);

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    media.setMatches(true);

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  });

  it("falls back to dark theme without matchMedia and covers login state", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: undefined
    });
    window.localStorage.clear();
    render(<App />);

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(screen.getByRole("heading", { name: "Dashboard token required" })).toBeTruthy();
  });

  it("applies the same theme root while loading dashboard data", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: undefined
    });
    render(<App api={loadingApi()} />);

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(screen.getByRole("heading", { name: "Loading dashboard" })).toBeTruthy();
  });

  it("applies the same theme root while showing dashboard errors", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: undefined
    });
    render(<App api={failingApi()} />);

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(await screen.findByRole("heading", { name: "Dashboard unavailable" })).toBeTruthy();
  });

  it("renders blocked command center state", () => {
    render(<App api={noopApi()} initialData={fixture("BLOCKED")} />);

    expect(screen.getByRole("heading", { name: "Mission Control" })).toBeTruthy();
    expect(screen.getByText("policy_violation")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /PR Inbox/ }));
    expect(screen.getByText("Please tighten dashboard tests.")).toBeTruthy();
    expect(screen.getByText("reviewer")).toBeTruthy();
  });

  it("renders every P0 dashboard page", () => {
    render(<App api={noopApi()} initialData={fixture("BLOCKED")} />);

    fireEvent.click(screen.getByRole("button", { name: "Gate Center" }));
    expect(screen.getByRole("heading", { name: "Gate Center" })).toBeTruthy();
    expect(screen.getAllByText("policy_violation").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "PR Inbox" }));
    expect(screen.getByRole("heading", { name: "PR Inbox" })).toBeTruthy();
    expect(screen.getByText("#42 OPEN")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Worker Runs" }));
    expect(screen.getByRole("heading", { name: "Worker Runs" })).toBeTruthy();
    expect(screen.getByText("worker.log")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Scope Guard" }));
    expect(screen.getByRole("heading", { name: "Scope Guard" })).toBeTruthy();
    expect(screen.getByText("No scope guard evidence yet.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Event Ledger" }));
    expect(screen.getByRole("heading", { name: "Event Ledger" })).toBeTruthy();
    expect(screen.getByText("Dashboard fixture ready.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Artifact Diff Viewer" }));
    expect(screen.getByRole("heading", { name: "Artifact Diff Viewer" })).toBeTruthy();
    expect(screen.getByText("Select an artifact to inspect registered content.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Recovery Center" }));
    expect(screen.getByRole("heading", { name: "Recovery Center" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run Explicit Recovery" })).toBeTruthy();
  });

  it("renders timeline summary on mission control", () => {
    render(<App api={noopApi()} initialData={fixture("RUNNING")} />);

    expect(screen.getAllByText("Latest action").length).toBeGreaterThan(0);
    expect(screen.getByText("event: dashboard.seeded")).toBeTruthy();
    expect(screen.getByText("Observation gap")).toBeTruthy();
    expect(screen.getAllByText("no gap").length).toBeGreaterThan(0);
  });

  it("renders workflow profile summary on mission control", () => {
    render(<App api={noopApi()} initialData={fixture("RUNNING")} />);

    expect(screen.getByText("Workflow")).toBeTruthy();
    expect(screen.getAllByText("Default PR loop").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Workflow profile").length).toBeGreaterThan(0);
    expect(screen.getByText("Default PR roles")).toBeTruthy();
    expect(screen.getByText("Reviewer / read-only")).toBeTruthy();
  });

  it("renders the PR delivery workflow board and unknown review rows", async () => {
    window.history.replaceState({}, "", "/?fixture=workflow-review-active");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "PR Delivery Workflow" })).toBeTruthy();
    for (const label of ["Work Item", "Plan", "Build", "Verify", "PR", "Review", "Merge Readiness", "Cleanup"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Review report matrix")).toBeTruthy();
    expect(screen.getByText("AGY/Gemini")).toBeTruthy();
    expect(screen.getAllByText(/unknown/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("no requirement source").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Attach Evidence")).toBeTruthy();

    const missionChildren = Array.from(document.querySelector(".mission-grid")?.children ?? []);
    expect(missionChildren[0]?.classList.contains("summary-panel--mission")).toBe(true);
    expect(missionChildren[1]?.classList.contains("workflow-board")).toBe(true);
    expect(missionChildren[2]?.classList.contains("focus-panel")).toBe(true);
  });

  it("loads the workflow board for the current Mission Control run", async () => {
    const workflowBoard = vi.fn(async () => ({
      ok: true,
      data: workflowBoardData({ activeStageId: "merge_readiness", summary: "Sandbox PR ready." })
    }));
    render(
      <MissionControl
        data={fixture("RUNNING")}
        api={{ ...noopApi(), workflowBoard }}
        stale={false}
        locale="en-US"
      />
    );

    expect(await screen.findByText("#60 Render real workflow board data")).toBeTruthy();
    expect(await screen.findByText("Sandbox PR ready.")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(workflowBoard).toHaveBeenCalledWith({ runId: "run-1" });
  });

  it("renders structured review evidence dimensions", async () => {
    const board = workflowBoardData({ activeStageId: "review", summary: "Review evidence visible." });
    board.reviewReports = [{
      id: "review-1",
      agent: "Claude ACP",
      status: "pass",
      prComment: "posted",
      severitySummary: "none",
      requirement: "required",
      progress: "complete",
      result: "pass",
      model: "Claude ACP",
      sessionId: "session-1",
      commentUrl: "https://github.com/6tizer/codex-auto-PR-loop-plusin/pull/1#issuecomment-1",
      commentId: "1",
      evidenceRefIds: []
    }];
    render(
      <MissionControl
        data={fixture("RUNNING")}
        api={{ ...noopApi(), workflowBoard: async () => ({ ok: true, data: board }) }}
        stale={false}
        locale="en-US"
      />
    );

    expect(await screen.findByText("Requirement")).toBeTruthy();
    expect(screen.getByText("Progress")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByText("Complete")).toBeTruthy();
    expect(screen.getByText("Passed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Posted" })).toBeTruthy();
    expect(screen.getByText(/session: session-1/)).toBeTruthy();
  });

  it("refreshes the workflow board when Mission Control run evidence changes", async () => {
    const first = fixture("RUNNING");
    const refreshed = {
      ...fixture("RUNNING"),
      current: {
        ...fixture("RUNNING").current,
        run: {
          ...fixture("RUNNING").current.run!,
          updatedAt: "2026-06-12T10:01:00.000Z"
        }
      },
      events: [{
        id: "event-2",
        seq: 2,
        kind: "workflow_stage_evidence",
        message: "Cleanup evidence visible.",
        createdAt: "2026-06-12T10:01:00.000Z"
      }]
    };
    const workflowBoard = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        data: workflowBoardData({ activeStageId: "review", summary: "Review evidence visible." })
      })
      .mockResolvedValueOnce({
        ok: true,
        data: workflowBoardData({ activeStageId: "cleanup", summary: "Cleanup evidence visible." })
      });
    const { rerender } = render(
      <MissionControl
        data={first}
        api={{ ...noopApi(), workflowBoard }}
        stale={false}
        locale="en-US"
      />
    );

    expect(await screen.findByText("Review evidence visible.")).toBeTruthy();

    rerender(
      <MissionControl
        data={refreshed}
        api={{ ...noopApi(), workflowBoard }}
        stale={false}
        locale="en-US"
      />
    );

    expect(await screen.findByText("Cleanup evidence visible.")).toBeTruthy();
    expect(workflowBoard).toHaveBeenCalledTimes(2);
    expect(workflowBoard).toHaveBeenLastCalledWith({ runId: "run-1" });
  });

  it("keeps a late no-run workflow response from replacing the current run board", async () => {
    const noRunBoard = deferred<ReturnType<NonNullable<DashboardApi["workflowBoard"]>> extends Promise<infer T> ? T : never>();
    const currentRunBoard = deferred<ReturnType<NonNullable<DashboardApi["workflowBoard"]>> extends Promise<infer T> ? T : never>();
    const workflowBoard = vi.fn()
      .mockReturnValueOnce(noRunBoard.promise)
      .mockReturnValueOnce(currentRunBoard.promise);
    const fixtureData = fixture("RUNNING");
    const { run: _run, ...currentWithoutRun } = fixtureData.current;
    const initial = {
      ...fixture("RUNNING"),
      current: currentWithoutRun
    };
    const { rerender } = render(
      <MissionControl
        data={initial}
        api={{ ...noopApi(), workflowBoard }}
        stale={false}
        locale="en-US"
      />
    );

    rerender(
      <MissionControl
        data={fixture("RUNNING")}
        api={{ ...noopApi(), workflowBoard }}
        stale={false}
        locale="en-US"
      />
    );
    currentRunBoard.resolve({
      ok: true,
      data: workflowBoardData({ activeStageId: "cleanup", summary: "Current run cleanup evidence." })
    });

    expect(await screen.findByText("Current run cleanup evidence.")).toBeTruthy();
    noRunBoard.resolve({
      ok: true,
      data: workflowBoardData({ activeStageId: "work_item", summary: "Late empty board response." })
    });

    await waitFor(() => expect(screen.queryByText("Late empty board response.")).toBeNull());
    expect(screen.getByText("Current run cleanup evidence.")).toBeTruthy();
    expect(workflowBoard).toHaveBeenNthCalledWith(1, undefined);
    expect(workflowBoard).toHaveBeenNthCalledWith(2, { runId: "run-1" });
  });

  it("shows workflow stage previews on hover and closes them on mouse leave", async () => {
    window.history.replaceState({}, "", "/?fixture=workflow-review-active");
    render(<App />);

    await screen.findByRole("heading", { name: "PR Delivery Workflow" });
    const verifyStage = document.querySelector<HTMLElement>('[data-stage-id="verify"]');
    expect(verifyStage).toBeTruthy();

    fireEvent.mouseEnter(verifyStage!);
    expect(await screen.findByRole("dialog", { name: "Verify" })).toBeTruthy();

    fireEvent.mouseLeave(verifyStage!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Verify" })).toBeNull());
  });

  it("keeps the workflow inspector as a lightweight collapsed rail", async () => {
    window.history.replaceState({}, "", "/?fixture=workflow-review-active");
    render(<App />);

    await screen.findByRole("heading", { name: "PR Delivery Workflow" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse inspector" }));

    expect(document.querySelector(".workflow-inspector.is-collapsed")).toBeTruthy();
    expect(document.querySelector(".workflow-inspector__collapsed")?.getAttribute("aria-label")).toBe("Review");
    expect(document.querySelector(".workflow-inspector__dot")).toBeTruthy();
    expect(document.querySelector(".workflow-detail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open inspector" })).toBeTruthy();
  });

  it("renders workflow board mobile view without desktop table overflow assumptions", async () => {
    setViewportWidth(390);
    window.history.replaceState({}, "", "/?fixture=workflow-merge-blocked");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "PR Delivery Workflow" })).toBeTruthy();
    expect(screen.getByText("Merge readiness checklist")).toBeTruthy();
    expect(document.querySelector(".workflow-rail")).toBeTruthy();
    expect(document.querySelector(".workflow-matrix__row")).toBeTruthy();
  });

  it("keeps the mission control summary focused on the five primary operator questions", () => {
    render(<App api={noopApi()} initialData={fixture("RUNNING")} />);

    const summary = document.querySelector(".summary-panel--mission");
    expect(summary).toBeTruthy();
    const labels = Array.from(summary!.querySelectorAll(".metric-row span")).map((element) => element.textContent);
    expect(labels).toEqual(["Next action", "Autonomy boundary", "Attention", "Merge readiness", "Workflow"]);
  });

  it("renders mobile stress data as compact cards instead of a duplicate desktop table", () => {
    setViewportWidth(390);
    window.history.replaceState({}, "", "/?fixture=mobile-table-stress");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Gate Center" }));

    expect(document.querySelectorAll(".compact-data-card").length).toBeGreaterThan(0);
    expect(document.querySelector(".table-panel table")).toBeNull();
    expect(screen.getAllByText(/confirmation_required_with_extremely_long_identifier/).length).toBeGreaterThan(0);
  });

  it("distinguishes historical gates and stale worker failures in dashboard views", () => {
    window.history.replaceState({}, "", "/?fixture=historical-worker-failure");
    render(<App />);

    expect(screen.getAllByText("current run 1 / repo total 2 / historical 1 / stale 1").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Gate Center" }));
    expect(screen.getByText("Active gates drive operator actions. Active 1 / historical 1 / repo total 2.")).toBeTruthy();
    expect(screen.getAllByText("Raw/original message").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Historical").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Worker failed in a previous run; a newer run has already superseded it.").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Worker Runs" }));
    expect(screen.getAllByText("current run 1 / repo total 2 / historical 1 / stale 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stale worker").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Old worker failed before the current run started.").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Recovery Center" }));
    expect(screen.getByText("Historical gates")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark Handled" })).toBeTruthy();
  });

  it("summarizes long raw gate messages in compact cards", () => {
    setViewportWidth(390);
    window.history.replaceState({}, "", "/?fixture=mobile-table-stress");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Gate Center" }));

    const cardSummary = Array.from(document.querySelectorAll(".compact-data-card p"))
      .map((element) => element.textContent ?? "")
      .find((text) => text.includes("A very long dashboard field")) ?? "";
    expect(cardSummary.length).toBeLessThan(180);
    expect(cardSummary.endsWith("...")).toBe(true);
    expect(screen.getAllByText("Raw/original message").length).toBeGreaterThan(0);
  });

  it("returns no raw message summary for empty messages", () => {
    expect(summarizeRawMessage(undefined, "en-US")).toBeUndefined();
    expect(summarizeRawMessage("", "en-US")).toBeUndefined();
  });

  it("does not label mission-control worker previews as repo totals", () => {
    window.history.replaceState({}, "", "/?fixture=many-events");
    render(<App />);

    const bodyText = document.body.textContent ?? "";
    expect(bodyText.includes("repo total 10") || bodyText.includes("仓库总数 10")).toBe(true);
    expect(bodyText.includes("repo total 5")).toBe(false);
    expect(bodyText.includes("仓库总数 5")).toBe(false);
    expect(bodyText.includes("Showing 5 of 10 repo-scope workers") || bodyText.includes("前 5/10 项")).toBe(true);
  });

  it("does not enable gate approval for historical-only blocked run fixtures", () => {
    window.history.replaceState({}, "", "/?fixture=historical-blocked-run");
    render(<App />);

    expect(screen.getByText("No intervention needed")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Approve/ }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Recovery Center" }));
    expect(screen.getByText("Only historical gates are visible here; they belong to inactive or superseded runs.")).toBeTruthy();
  });

  it("does not offer mark-handled for already closed historical gates", () => {
    const data = fixture("READY");
    delete data.current.gate;
    data.gates = [{
      ...data.gates[0]!,
      status: "approved",
      activity: "historical",
      activityReason: "handled_gate"
    }];
    render(<App api={noopApi()} initialData={data} />);

    fireEvent.click(screen.getByRole("button", { name: "Recovery Center" }));
    expect(screen.getByText("Historical gates")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark Handled" })).toBeNull();
  });

  it("re-evaluates historical gates and shows the returned result", async () => {
    const data = fixture("READY");
    delete data.current.gate;
    data.gates = [{
      ...data.gates[0]!,
      status: "approved",
      activity: "historical",
      activityReason: "handled_gate"
    }];
    const api = {
      ...noopApi(),
      missionControl: vi.fn(async () => ({ ok: true, data })),
      mutate: vi.fn(async (path: string) => ({
        ok: true,
        data: {
          gate: data.gates[0]!,
          result: "still_historical",
          reevaluated: true
        }
      }))
    };
    render(<App api={api} initialData={data} />);

    fireEvent.click(screen.getByRole("button", { name: "Recovery Center" }));
    expect(screen.getByRole("button", { name: "Re-evaluate" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark Handled" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Re-evaluate" }));

    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith("/api/gates/gate-1/re-evaluate", undefined));
    expect(await screen.findByText("Re-evaluate result")).toBeTruthy();
    expect(screen.getByText("Still historical; no current active gate matches this record.")).toBeTruthy();
  });

  it("does not treat unannotated open gates as active intervention gates", () => {
    const data = fixture("BLOCKED");
    data.gates = data.gates.map(({ activity: _activity, activityReason: _activityReason, ...gate }) => gate);
    render(<App api={noopApi()} initialData={data} />);

    expect(screen.getByRole("button", { name: /Approve/ }).hasAttribute("disabled")).toBe(true);
  });

  it("renders stale-gate fixtures as overridden historical gates", () => {
    window.history.replaceState({}, "", "/?fixture=stale-gate");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Gate Center" }));
    expect(screen.getAllByText("Overridden").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Recovery Center" }));
    expect(screen.getByText("overridden by reality check")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark Handled" })).toBeTruthy();
  });

  it("renders agent timeline empty state", async () => {
    const api = {
      ...noopApi(),
      agentTimeline: vi.fn(async () => ({ ok: true, data: { entries: [] } }))
    };
    render(<App api={api} initialData={fixture("RUNNING")} />);

    fireEvent.click(screen.getByRole("button", { name: "Observability Console" }));

    expect(await screen.findByText("No timeline entries")).toBeTruthy();
    expect(screen.getByText("No timeline entries match this filter.")).toBeTruthy();
    expect(screen.getByText("Full-cycle local activity")).toBeTruthy();
  });

  it("loads additional agent timeline pages", async () => {
    const firstEntry = timelineEntryFixture(1, "First timeline item");
    const secondEntry = timelineEntryFixture(2, "Second timeline item");
    const api = {
      ...noopApi(),
      agentTimeline: vi.fn(async (options?: Parameters<DashboardApi["agentTimeline"]>[0]) => ({
        ok: true,
        data: options?.cursor
          ? { entries: [secondEntry] }
          : { entries: [firstEntry], nextCursor: "cursor-2" }
      }))
    };
    render(<App api={api} initialData={fixture("RUNNING")} />);

    fireEvent.click(screen.getByRole("button", { name: "Observability Console" }));
    expect((await screen.findAllByText("First timeline item")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));

    expect((await screen.findAllByText("Second timeline item")).length).toBeGreaterThan(0);
    expect(api.agentTimeline).toHaveBeenLastCalledWith({
      limit: 50,
      runId: "run-1",
      cursor: "cursor-2"
    });
  });

  it("expands worker events without repeating empty-result requests", async () => {
    const data = fixture("RUNNING");
    data.workers = [{
      id: "worker-empty",
      type: "implementation",
      status: "running",
      startedAt: "2026-06-12T10:00:00.000Z"
    }];
    const api = {
      ...noopApi(),
      agentTimeline: vi.fn(async () => ({ ok: true, data: { entries: [] } }))
    };
    render(<App api={api} initialData={data} />);

    fireEvent.click(screen.getByRole("button", { name: "Worker Runs" }));
    fireEvent.click(firstSummaryByText("Worker events"));
    await waitFor(() => expect(api.agentTimeline).toHaveBeenCalledTimes(1));
    fireEvent.click(firstSummaryByText("Worker events"));
    fireEvent.click(firstSummaryByText("Worker events"));

    await waitFor(() => expect(api.agentTimeline).toHaveBeenCalledTimes(1));
    expect(api.agentTimeline).toHaveBeenCalledWith({
      workerId: "worker-empty",
      sources: ["worker_event"],
      limit: 25
    });
  });

  it("renders high-fidelity worker event types in worker expansion", async () => {
    const entries = [
      timelineEntryFixture(1, "command_execution", "pnpm test is running"),
      timelineEntryFixture(2, "mcp_tool_call", "gitnexus impact query completed"),
      timelineEntryFixture(3, "web_search", "searched official docs"),
      timelineEntryFixture(4, "todo_list", "3 todos, 1 in progress"),
      timelineEntryFixture(5, "error", "worker command failed with exit code 1")
    ].map((entry) => ({ ...entry, source: "worker_event" as const }));
    const data = fixture("RUNNING", "blocked");
    data.workers = [{
      id: "worker-h2",
      type: "implementation",
      status: "running",
      startedAt: "2026-06-12T10:00:00.000Z"
    }];
    const api = {
      ...noopApi(),
      agentTimeline: vi.fn(async () => ({ ok: true, data: { entries } }))
    };
    render(<App api={api} initialData={data} />);

    fireEvent.click(screen.getByRole("button", { name: "Worker Runs" }));
    fireEvent.click(firstSummaryByText("Worker events"));

    expect(await screen.findByText("mcp_tool_call")).toBeTruthy();
    expect(screen.getByText("web_search")).toBeTruthy();
    expect(screen.getByText("todo_list")).toBeTruthy();
    expect(screen.getByText("error")).toBeTruthy();
  });

  it("renders running and green states", () => {
    render(<App api={noopApi()} initialData={fixture("RUNNING", "success")} />);

    const topbar = screen.getAllByText("AUTONOMY")[0]?.closest(".top-metric");
    expect(topbar ? within(topbar as HTMLElement).getAllByText("Until next gate").length : 0).toBeGreaterThan(0);
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
  });

  it("does not treat resolved gates as active operator actions", () => {
    const data = fixture("BLOCKED");
    delete data.current.gate;
    data.gates[0] = { ...data.gates[0]!, status: "resolved" };
    data.notifications = [];
    render(<App api={noopApi()} initialData={data} />);

    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "reviewed" } });

    expect(screen.getByRole("heading", { name: "No intervention needed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reject" })).toHaveProperty("disabled", true);
  });

  it("keeps collapsed sidebar navigation buttons labelled", () => {
    render(<CommandCenter api={noopApi()} data={fixture("RUNNING")} stale={false} onRefresh={vi.fn()} locale="en-US" localeSetting="en-US" onLocaleSettingChange={vi.fn()} themeSetting="dark" effectiveTheme="dark" onThemeSettingChange={vi.fn()} />);

    [
      "Mission Control",
      "Plan Navigator",
      "Policy Config",
      "Dry-run Preview",
      "Notifications",
      "Observability Console",
      "Gate Center",
      "PR Inbox",
      "Worker Runs",
      "Scope Guard",
      "Event Ledger",
      "Artifact Diff Viewer",
      "Recovery Center"
    ].forEach((label) => {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    });
  });

  it("clears operator notes when the active gate changes", async () => {
    const api = noopApi();
    const first = fixture("BLOCKED");
    const second = fixture("BLOCKED");
    second.gates[0] = {
      ...second.gates[0]!,
      id: "gate-2",
      message: "A different gate needs a fresh operator note."
    };
    second.current.gate = {
      kind: "policy_violation",
      message: "A different gate needs a fresh operator note."
    };
    const view = render(<CommandCenter api={api} data={first} stale={false} onRefresh={vi.fn()} locale="en-US" localeSetting="en-US" onLocaleSettingChange={vi.fn()} themeSetting="system" effectiveTheme="dark" onThemeSettingChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "reviewed" } });
    expect(screen.getByRole("button", { name: "Approve" })).toHaveProperty("disabled", false);

    view.rerender(<CommandCenter api={api} data={second} stale={false} onRefresh={vi.fn()} locale="en-US" localeSetting="en-US" onLocaleSettingChange={vi.fn()} themeSetting="system" effectiveTheme="dark" onThemeSettingChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Decision note")).toHaveProperty("value", ""));
    expect(screen.getByRole("button", { name: "Approve" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reject" })).toHaveProperty("disabled", true);
  });

  it("routes operator controls through dashboard API mutations", async () => {
    const api = trackedApi();
    render(<App api={api} initialData={fixture("BLOCKED")} />);

    fireEvent.click(screen.getByRole("button", { name: "Run to Gate" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(4));
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "reviewed" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(5));
    fireEvent.change(screen.getByLabelText("Decision note"), { target: { value: "rejected separately" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(6));

    expect(api.mutate).toHaveBeenCalledWith("/api/run-until-gate", undefined);
    expect(api.mutate).toHaveBeenCalledWith("/api/step", undefined);
    expect(api.mutate).toHaveBeenCalledWith("/api/resume", undefined);
    expect(api.mutate).toHaveBeenCalledWith("/api/stop", undefined);
    expect(api.mutate).toHaveBeenCalledWith("/api/gates/gate-1/approve", { note: "reviewed", source: "ui", payload: {} });
    expect(api.mutate).toHaveBeenCalledWith("/api/gates/gate-1/reject", { note: "rejected separately", source: "ui", payload: {} });
  });

  it("reads artifact content through the dashboard API", async () => {
    const api = trackedApi();
    render(<App api={api} initialData={fixture("BLOCKED")} />);

    fireEvent.click(screen.getByRole("button", { name: "Artifact Diff Viewer" }));
    fireEvent.click(screen.getByRole("button", { name: "Read" }));

    await waitFor(() => expect(api.artifact).toHaveBeenCalledWith("artifact-1"));
    expect(await screen.findByText("worker completed")).toBeTruthy();
  });

  it("resets policy config diff after a successful save", async () => {
    const api = trackedApi();
    render(<App api={api} initialData={fixture("BLOCKED")} />);

    fireEvent.click(screen.getByRole("button", { name: "Policy Config" }));
    expect(await screen.findByText("Diff Before Save")).toBeTruthy();
    const notificationsSummary = screen.getAllByText("Notifications").find((element) => element.closest("summary"));
    expect(notificationsSummary).toBeTruthy();
    fireEvent.click(notificationsSummary!);
    fireEvent.change(screen.getByLabelText("Notification mode"), { target: { value: "blockers_only" } });
    fireEvent.change(screen.getByLabelText("Policy change note"), { target: { value: "save check" } });
    expect(screen.getByRole("button", { name: "Save Config" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Save Config" }));

    expect(await screen.findByText("Config saved")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Config" })).toHaveProperty("disabled", true));
    expect(screen.getByText("No changes yet.")).toBeTruthy();
  });

  it("requires CONFIRM before saving dangerous policy config changes", async () => {
    render(<App api={trackedApi()} initialData={fixture("BLOCKED")} />);

    fireEvent.click(screen.getByRole("button", { name: "Policy Config" }));
    expect(await screen.findByText("Diff Before Save")).toBeTruthy();
    const mergeSummary = screen.getAllByText("Manual").find((element) => element.closest("summary"));
    expect(mergeSummary).toBeTruthy();
    fireEvent.click(mergeSummary!);
    fireEvent.click(screen.getByLabelText("Require review approval"));
    fireEvent.change(screen.getByLabelText("Policy change note"), { target: { value: "dangerous change" } });
    expect(screen.getByText("Dangerous policy change: type CONFIRM before saving.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save Config" })).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Confirmation token"), { target: { value: "CONFIRM" } });
    expect(screen.getByRole("button", { name: "Save Config" })).toHaveProperty("disabled", false);
  });

  it("localizes policy config labels without coupling config locale to local UI language", async () => {
    window.localStorage.setItem("agent-loop-dashboard-locale", "zh-CN");
    const data = fixture("BLOCKED");
    delete data.ci[0]!.conclusion;
    render(<App api={trackedApi()} initialData={data} />);

    expect(screen.getByText("高风险")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "通知" }));
    expect(screen.getAllByText("已阻塞").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "PR 收件箱" }));
    expect(screen.getByText("待定")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "策略配置" }));
    expect(await screen.findByText("保存前 Diff")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("仓库默认语言"), { target: { value: "en-US" } });

    expect(screen.getByRole("heading", { name: "策略配置" })).toBeTruthy();
    expect(window.localStorage.getItem("agent-loop-dashboard-locale")).toBe("zh-CN");
    expect(screen.getByLabelText("自治模式")).toBeTruthy();
    expect(screen.getByText("受保护")).toBeTruthy();
  });

  it("truncates large artifact previews", () => {
    const preview = decodeBase64Preview("artifact", "A".repeat(500_001));

    expect(preview.truncated).toBe(true);
    expect(preview.text).toContain("too large");
  });

  it("shows artifact read errors when the dashboard API throws", async () => {
    render(<App api={throwingArtifactApi()} initialData={fixture("BLOCKED")} />);

    fireEvent.click(screen.getByRole("button", { name: "Artifact Diff Viewer" }));
    fireEvent.click(screen.getByRole("button", { name: "Read" }));

    expect(await screen.findByText("artifact fetch failed")).toBeTruthy();
  });

  it("shows an artifact read loading state", async () => {
    const pending = deferred<Awaited<ReturnType<DashboardApi["artifact"]>>>();
    render(<App api={pendingArtifactApi(pending.promise)} initialData={fixture("BLOCKED")} />);

    fireEvent.click(screen.getByRole("button", { name: "Artifact Diff Viewer" }));
    fireEvent.click(screen.getByRole("button", { name: "Read" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Reading" })).toHaveProperty("disabled", true));
    pending.resolve({ ok: true, data: { record: artifactFixture(), contentBase64: Buffer.from("slow artifact", "utf8").toString("base64") } });
    expect(await screen.findByText("slow artifact")).toBeTruthy();
  });

  it("renders error state without raw stack traces", async () => {
    render(<App api={failingApi()} />);

    expect(await screen.findByText("Dashboard unavailable")).toBeTruthy();
    expect(screen.getByText("Missing config")).toBeTruthy();
    expect(screen.queryByText(/at Object\./)).toBeNull();
  });

  it("renders dashboard fixture scenarios without network calls", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const name of dashboardFixtureNames) {
      cleanup();
      window.history.replaceState({}, "", `/?fixture=${name}`);
      render(<App />);

      expect(screen.getByRole("heading", { name: "Mission Control" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
      expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders generic repo hygiene fixture gate and deliverable semantics", () => {
    window.history.replaceState({}, "", "/?fixture=generic-human-gate");

    render(<App />);

    expect(screen.getByText("Repo hygiene audit report")).toBeTruthy();
    expect(screen.getByText("generic_human_gate")).toBeTruthy();
    expect(document.body.textContent).toContain("Repo hygiene loop");
    expect(document.body.textContent).toContain("generic-loop");
  });

  it("clears query token and sends it only as an artifact header", async () => {
    window.history.replaceState({}, "", "/?token=secret-token&view=ops");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} }), {
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createDashboardApi();
    await api.artifact("artifact-1");

    expect(window.location.search).toBe("?view=ops");
    expect(fetchMock).toHaveBeenCalledWith("/api/artifacts/artifact-1", {
      headers: {
        accept: "application/json",
        "x-agent-loop-token": "secret-token"
      }
    });

    const reloadedApi = createDashboardApi();
    await reloadedApi.artifact("artifact-2");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/artifacts/artifact-2", {
      headers: {
        accept: "application/json",
        "x-agent-loop-token": "secret-token"
      }
    });
  });

  it("prefers runtime token over query token and stored token", () => {
    window.history.replaceState({}, "", "/?token=query-token&view=ops");
    window.localStorage.setItem("agent-loop-dashboard-token", "stored-token");
    window.__AGENT_LOOP_DASHBOARD_TOKEN__ = "runtime-token";

    expect(storedDashboardToken()).toBe("runtime-token");
    expect(window.location.search).toBe("?view=ops");
    expect(window.localStorage.getItem("agent-loop-dashboard-token")).toBe("runtime-token");
    expect(window.__AGENT_LOOP_DASHBOARD_TOKEN__).toBeUndefined();
  });
});

function liveDashboardResponse(path: string): unknown {
  if (path === "/api/mission-control") {
    return { ok: true, data: fixture("RUNNING") };
  }
  if (path === "/api/dashboard-meta") {
    return { ok: true, data: { appName: "HOLO-Codex", surface: "dashboard" } };
  }
  if (path === "/api/policy-config") {
    return {
      ok: true,
      data: {
        config: { repoId: "example/fixture", locale: "en-US" },
        path: "/tmp/config.json",
        exists: true
      }
    };
  }
  return { ok: true, data: {} };
}

function installLocalStorage(): void {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    }
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage
  });
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width
  });
  window.dispatchEvent(new Event("resize"));
}

function installMatchMedia(initialMatches: boolean): { setMatches: (matches: boolean) => void } {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => true
  } as MediaQueryList;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => query
  });
  return {
    setMatches: (next) => {
      matches = next;
      const event = { matches: next, media: query.media } as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    }
  };
}

function noopApi(): DashboardApi {
  return {
    missionControl: async () => ({ ok: true, data: fixture("RUNNING") }),
    events: async () => ({ ok: true, data: { events: [] } }),
    mutate: async () => ({ ok: true, data: {} }),
    artifact: async () => ({ ok: true, data: { record: artifactFixture(), contentBase64: "" } }),
    ...dashboardApiExtras()
  };
}

function trackedApi(): DashboardApi {
  return {
    missionControl: vi.fn(async () => ({ ok: true, data: fixture("RUNNING") })),
    events: vi.fn(async () => ({ ok: true, data: { events: [] } })),
    mutate: vi.fn(async () => ({ ok: true, data: {} })),
    artifact: vi.fn(async () => ({
      ok: true,
      data: {
        record: artifactFixture(),
        contentBase64: Buffer.from("worker completed", "utf8").toString("base64")
      }
    })),
    ...dashboardApiExtras()
  };
}

function apiWithRepoLocale(locale: string | undefined): DashboardApi {
  return {
    ...noopApi(),
    policyConfig: async () => {
      const base = await dashboardApiExtras().policyConfig();
      if (!base.ok || !base.data) return base;
      const { locale: _locale, ...withoutLocale } = base.data.config;
      return {
        ok: true,
        data: {
          ...base.data,
          config: locale ? { ...base.data.config, locale } : withoutLocale
        }
      };
    }
  };
}

function throwingArtifactApi(): DashboardApi {
  return {
    missionControl: async () => ({ ok: true, data: fixture("RUNNING") }),
    events: async () => ({ ok: true, data: { events: [] } }),
    mutate: async () => ({ ok: true, data: {} }),
    artifact: async () => {
      throw new Error("artifact fetch failed");
    },
    ...dashboardApiExtras()
  };
}

function pendingArtifactApi(promise: ReturnType<DashboardApi["artifact"]>): DashboardApi {
  return {
    missionControl: async () => ({ ok: true, data: fixture("RUNNING") }),
    events: async () => ({ ok: true, data: { events: [] } }),
    mutate: async () => ({ ok: true, data: {} }),
    artifact: async () => await promise,
    ...dashboardApiExtras()
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function firstSummaryByText(text: string): HTMLElement {
  const summary = screen.getAllByText(text).find((element) => element.tagName === "SUMMARY");
  if (!summary) throw new Error(`Missing summary: ${text}`);
  return summary;
}

function artifactFixture(): MissionControlData["artifacts"][number] {
  return {
    id: "artifact-1",
    kind: "log",
    name: "worker.log",
    path: ".agent-loop/artifacts/run/log/worker.log",
    createdAt: "2026-06-12T10:00:00.000Z"
  };
}

function failingApi(): DashboardApi {
  return {
    missionControl: async () => ({ ok: false, error: { code: "needs_repo_init", message: "Missing config" } }),
    events: async () => ({ ok: false, error: { code: "needs_repo_init", message: "Missing config" } }),
    mutate: async () => ({ ok: false, error: { code: "needs_repo_init", message: "Missing config" } }),
    artifact: async () => ({ ok: false, error: { code: "needs_repo_init", message: "Missing config" } }),
    ...dashboardApiExtras()
  };
}

function loadingApi(): DashboardApi {
  const never = new Promise<never>(() => {});
  return {
    missionControl: async () => await never,
    events: async () => await never,
    mutate: async () => await never,
    artifact: async () => await never,
    dashboardMeta: async () => await never,
    plan: async () => await never,
    policyConfig: async () => await never,
    dryRunPreview: async () => await never,
    notifications: async () => await never,
    agentTimeline: async () => await never,
    observe: async () => await never,
    auditExport: async () => await never
  };
}

function workflowBoardData({ activeStageId, summary }: { activeStageId: WorkflowStageId; summary: string }): WorkflowBoard {
  const stageIds: WorkflowStageId[] = ["work_item", "plan", "build", "verify", "pr", "review", "merge_readiness", "cleanup"];
  return {
    runId: "run-1",
    mode: "active",
    activeStageId,
    selectedStageId: activeStageId,
    workItem: {
      issueNumber: 60,
      issueTitle: "Render real workflow board data",
      runId: "run-1",
      currentState: "WAIT_REVIEW_OR_CI",
      status: "RUNNING",
      loopShape: "pr-loop",
      prNumber: 2,
      readOnly: false,
      lastUpdate: "2026-06-12T10:00:00.000Z"
    },
    stages: stageIds.map((id, index) => ({
      id,
      label: id === "merge_readiness" ? "Merge Readiness" : id.split("_").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" "),
      status: id === activeStageId ? "active" : index < stageIds.indexOf(activeStageId) ? "done" : "pending",
      actorChips: [{ actor: "codex", label: "Codex", status: id === activeStageId ? "active" : "pending" }],
      evidenceCounts: id === activeStageId ? { ...emptyWorkflowEvidenceCounts(), events: 1 } : emptyWorkflowEvidenceCounts(),
      substages: [{
        id: `${id}-summary`,
        label: "Summary",
        status: id === activeStageId ? "active" : "pending",
        evidenceCounts: id === activeStageId ? { ...emptyWorkflowEvidenceCounts(), events: 1 } : emptyWorkflowEvidenceCounts(),
        latestEvidence: [],
        requiredEvidence: []
      }],
      blockers: [],
      nextAction: "Inspect stage evidence."
    })),
    evidenceRefs: [{
      id: `${activeStageId}:event-1`,
      kind: "event",
      label: "Workflow evidence",
      summary,
      source: activeStageId,
      interaction: "drill_down_link",
      drillDownTarget: { page: "Event Ledger" },
      createdAt: "2026-06-12T10:00:00.000Z"
    }],
    reviewReports: [],
    verificationChecks: [],
    mergeReadinessChecks: [],
    cleanupChecks: [],
    appendEvidenceEnabled: true
  };
}

function emptyWorkflowEvidenceCounts(): WorkflowBoard["stages"][number]["evidenceCounts"] {
  return { events: 0, artifacts: 0, gates: 0, prComments: 0, gitnexus: 0, browser: 0, ci: 0, reports: 0 };
}

function dashboardApiExtras(): Pick<DashboardApi, "dashboardMeta" | "plan" | "policyConfig" | "dryRunPreview" | "notifications" | "agentTimeline" | "observe" | "auditExport"> {
  return {
    dashboardMeta: async () => ({
      ok: true,
      data: {
        appName: "HOLO-Codex",
        surface: "dashboard",
        targetRepo: { root: "/fixture/repo", repoId: "example/fixture" }
      }
    }),
    agentTimeline: async () => ({ ok: true, data: { entries: timelineFixture() } }),
    observe: async () => ({
      ok: true,
      data: {
        dashboard: { url: "http://127.0.0.1:0/", host: "127.0.0.1", port: 0, loopbackOnly: true },
        happy: { installed: false, supportsNotify: false },
        current: fixture("RUNNING").current,
        timeline: { entries: timelineFixture() }
      }
    }),
    plan: async () => ({ ok: true, data: { plan: fixture("RUNNING").plan! } }),
    policyConfig: async () => ({
      ok: true,
      data: {
        path: ".agent-loop/config.json",
        hash: "hash",
        mtimeMs: 1,
        config: {
          repoId: "example/fixture",
          locale: "en-US",
          baseBranch: "main",
          branchPrefix: "codex/",
          plansDir: "docs/plans",
          gitnexusRequired: true,
          requiredChecks: ["ci"],
          requireReviewApproval: true,
          autonomyMode: "autonomous_until_gate",
          mergeMode: "manual",
          notifyMode: "important_only",
          reviewHandling: "fix_scoped_and_carry_forward",
          carryoverTarget: "docs/local-release-readiness.md",
          allowAutoMerge: false,
          maxReviewFixRounds: 3,
          maxTestFixRounds: 2,
          maxCiReruns: 1,
          protectedPaths: [".agent-loop/**"]
        }
      }
    }),
    dryRunPreview: async () => ({
      ok: true,
      data: {
        nextPr: fixture("RUNNING").plan!.selectedNext!,
        branchName: "codex/pr-g-product-polish-config-ux",
        commandsPlanned: ["pnpm test"],
        workerType: "implementation",
        possibleGates: ["policy_violation"],
        missingConditions: ["required check green: ci"],
        filesLikelyTouched: ["plugins/autonomous-pr-loop"],
        autonomyForecast: fixture("RUNNING").autonomy!,
        mergeForecast: fixture("RUNNING").mergeReadiness!
      }
    }),
    notifications: async () => ({ ok: true, data: { notifications: fixture("RUNNING").notifications! } }),
    auditExport: async (options) => ({ ok: true, data: { runId: options.runId, format: options.format, content: "# audit\n" } })
  };
}

function fixture(status: string, ciConclusion = "pending"): MissionControlData {
  return {
    current: {
      status,
      nextAction: "Run required checks.",
      run: {
        id: "run-1",
        status,
        currentState: "SELF_CHECK",
        branch: "codex/pr-f-p0-dashboard",
        worktreeClean: true,
        updatedAt: "2026-06-12T10:00:00.000Z",
        startedAt: "2026-06-12T09:00:00.000Z"
      },
      gate: { kind: "policy_violation", message: "Self check required." }
    },
    gates: [{
      id: "gate-1",
      kind: "policy_violation",
      status: "open",
      activity: "active",
      activityReason: "current_run",
      message: "Self check required.",
      createdAt: "2026-06-12T10:00:00.000Z"
    }],
    pr: {
      prNumber: 42,
      url: "https://github.test/pr/42",
      branch: "codex/pr-f-p0-dashboard",
      state: "OPEN",
      draft: true,
      updatedAt: "2026-06-12T10:00:00.000Z"
    },
    ci: [{
      id: "ci-1",
      name: "ci",
      status: ciConclusion === "success" ? "completed" : "pending",
      conclusion: ciConclusion,
      observedAt: "2026-06-12T10:00:00.000Z"
    }],
    reviewComments: [{
      id: "comment-1",
      author: "reviewer",
      path: "plugins/autonomous-pr-loop/ui/src/app.tsx",
      body: "Please tighten dashboard tests.",
      actionable: true,
      isResolved: false,
      isOutdated: false,
      status: "open"
    }],
    workers: [{
      id: "worker-1",
      type: "reviewer",
      status: "succeeded",
      startedAt: "2026-06-12T10:00:00.000Z",
      resultArtifactId: "artifact-1"
    }],
    artifacts: [artifactFixture()],
    events: [{
      id: "event-1",
      seq: 1,
      kind: "dashboard.seeded",
      message: "Dashboard fixture ready.",
      createdAt: "2026-06-12T10:00:00.000Z"
    }],
    timelineSummary: {
      latest: timelineFixture()[0]!,
      hasObservationGap: false
    },
    autonomy: {
      autonomyMode: "autonomous_until_gate",
      mergeMode: "manual",
      notifyMode: "important_only",
      reviewHandling: "fix_scoped_and_carry_forward",
      summary: "Agent runs autonomous until gate; manual merge; notifications are important only.",
      notifyWhen: ["blocked", "confirmation_required"],
      requiresConfirmation: ["dangerous policy changes"],
      allowConditionalMerge: false
    },
    mergeReadiness: {
      state: "missing_evidence",
      ready: false,
      missingConditions: ["required check green: ci"],
      evidence: ["self check passed"],
      carryoverRecords: []
    },
    profile: {
      loopShape: "pr-loop",
      workflowProfile: "default_pr_loop",
      workflowLabel: "Default PR loop",
      workflowDescription: "The HOLO-Codex PR delivery behavior with explicit profile audit.",
      roleProfile: "default_pr_roles",
      currentRole: {
        state: "SELF_CHECK",
        alias: "reviewer",
        workerType: "reviewer",
        label: "Reviewer",
        sandbox: "read-only"
      },
      roleMapping: [{
        state: "WRITE_SPEC",
        alias: "planner",
        workerType: "planner",
        label: "Planner",
        sandbox: "workspace-write"
      }, {
        state: "IMPLEMENT",
        alias: "implementer",
        workerType: "implementation",
        label: "Implementer",
        sandbox: "workspace-write"
      }, {
        state: "SELF_CHECK",
        alias: "reviewer",
        workerType: "reviewer",
        label: "Reviewer",
        sandbox: "read-only"
      }],
      autonomyBoundary: "Autonomous until configured gates.",
      handoffSummary: "Follow the selected PR spec.",
      validationPosture: "Use configured validation.",
      likelyGates: ["worker_failed"],
      availableWorkflows: [{
        id: "default_pr_loop",
        label: "Default PR loop",
        description: "Default behavior."
      }],
      availableRoleProfiles: [{
        id: "default_pr_roles",
        label: "Default PR roles",
        description: "Default roles."
      }]
    },
    notifications: [{
      id: "gate:gate-1",
      severity: "blocked",
      title: "policy_violation",
      reason: "A policy guard blocked unsafe progress.",
      source: "gate",
      sourceId: "gate-1",
      createdAt: "2026-06-12T10:00:00.000Z"
    }],
    plan: {
      convention: "PR docs use pr-<letter> filenames.",
      currentMilestone: "PR G",
      selectedNext: {
        id: "PR G",
        title: "PR G Product Polish + Config UX",
        status: "next",
        file: "docs/local-release-readiness.md",
        dependsOn: ["PR F"],
        issueRefs: [],
        whySelected: "Final product polish PR."
      },
      completed: [],
      candidates: [],
      ambiguous: false,
      evidence: ["Parsed PR G SPEC."]
    },
    recoveryWarnings: []
  };
}

function timelineFixture() {
  return [timelineEntryFixture(1, "dashboard.seeded", "Dashboard fixture ready.")];
}

function timelineEntryFixture(seq: number, title: string, summary = title): AgentTimelineEntry {
  return {
    timelineSeq: seq,
    occurredAt: "2026-06-12T10:00:00.000Z",
    cursor: `cursor-${seq}`,
    source: "event" as const,
    kind: "dashboard.seeded",
    runId: "run-1",
    title,
    summary,
    createdAt: "2026-06-12T10:00:00.000Z",
    rawRef: { table: "events", id: `event-${seq}`, seq }
  };
}
