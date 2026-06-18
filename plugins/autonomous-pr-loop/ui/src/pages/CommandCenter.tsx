import {
  Activity,
  AlertTriangle,
  Archive,
  Bell,
  Bot,
  Boxes,
  CheckCircle2,
  CircleStop,
  Clock3,
  FileText,
  GitBranch,
  GitPullRequest,
  Languages,
  ListChecks,
  Monitor,
  Moon,
  Play,
  RotateCcw,
  Settings2,
  StepForward,
  Sun,
  TerminalSquare
} from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DashboardApi,
  DashboardResult,
  GateReevaluationData,
  DashboardMetaData,
  GateSummary,
  LoopNotification,
  MissionControlData
} from "../api.js";
import { ActivityBadge, activityReasonLabel } from "../components/ActivityBadge.js";
import { BrandMark } from "../components/BrandMark.js";
import { RiskBadge } from "../components/RiskBadge.js";
import { StatusBadge, toneForStatus } from "../components/StatusBadge.js";
import { TopMetric } from "../components/TopMetric.js";
import { displayValueLabel, localeOptionLabel, t, themeOptionLabel } from "../i18n.js";
import { THEME_SETTINGS, type EffectiveTheme, type ThemeSetting } from "../theme.js";
import { LOCALE_SETTINGS, type EffectiveLocale, type LocaleSetting } from "../../../core/locale.js";
import { AgentTimelineView as AgentTimelineSection } from "./agent-timeline/AgentTimelineView.js";
import { ArtifactViewer as ArtifactViewerSection } from "./artifact-viewer/ArtifactViewer.js";
import { formatTime, workerScopeSummary } from "./CommandCenterParts.js";
import { DryRunPreview as DryRunPreviewSection } from "./dry-run-preview/DryRunPreview.js";
import { EventLedger as EventLedgerSection } from "./event-ledger/EventLedger.js";
import { GateCenter as GateCenterSection } from "./gate-center/GateCenter.js";
import { MissionControl as MissionControlSection } from "./mission-control/MissionControl.js";
import { NotificationsView as NotificationsSection } from "./notifications/NotificationsView.js";
import { PlanNavigator as PlanNavigatorSection } from "./plan-navigator/PlanNavigator.js";
import { PolicyConfig as PolicyConfigSection } from "./policy-config/PolicyConfig.js";
import { PrInbox as PrInboxSection } from "./pr-inbox/PrInbox.js";
import { RecoveryCenter as RecoveryCenterSection } from "./recovery-center/RecoveryCenter.js";
import { ScopeGuard as ScopeGuardSection } from "./scope-guard/ScopeGuard.js";
import { WorkerRuns as WorkerRunsSection } from "./worker-runs/WorkerRuns.js";

interface CommandCenterProps {
  data: MissionControlData;
  meta?: DashboardMetaData | undefined;
  api: DashboardApi;
  stale: boolean;
  onRefresh: () => void;
  locale: EffectiveLocale;
  localeSetting: LocaleSetting;
  onLocaleSettingChange: (locale: LocaleSetting) => void;
  themeSetting: ThemeSetting;
  effectiveTheme: EffectiveTheme;
  onThemeSettingChange: (theme: ThemeSetting) => void;
  actionMessage?: string | undefined;
}

type Page =
  | "Mission Control"
  | "Plan Navigator"
  | "Policy Config"
  | "Dry-run Preview"
  | "Notifications"
  | "Agent Timeline"
  | "Gate Center"
  | "PR Inbox"
  | "Worker Runs"
  | "Scope Guard"
  | "Event Ledger"
  | "Artifact Diff Viewer"
  | "Recovery Center";

const pages: Array<{ name: Page; icon: typeof Activity }> = [
  { name: "Mission Control", icon: Activity },
  { name: "Plan Navigator", icon: GitBranch },
  { name: "Policy Config", icon: Settings2 },
  { name: "Dry-run Preview", icon: TerminalSquare },
  { name: "Notifications", icon: Bell },
  { name: "Agent Timeline", icon: Clock3 },
  { name: "Gate Center", icon: ListChecks },
  { name: "PR Inbox", icon: GitPullRequest },
  { name: "Worker Runs", icon: Bot },
  { name: "Scope Guard", icon: CheckCircle2 },
  { name: "Event Ledger", icon: Archive },
  { name: "Artifact Diff Viewer", icon: FileText },
  { name: "Recovery Center", icon: RotateCcw }
];

const pageKeys: Record<Page, string> = {
  "Mission Control": "pageMission",
  "Plan Navigator": "pagePlan",
  "Policy Config": "pagePolicy",
  "Dry-run Preview": "pageDryRun",
  "Notifications": "pageNotifications",
  "Agent Timeline": "pageTimeline",
  "Gate Center": "pageGates",
  "PR Inbox": "pagePr",
  "Worker Runs": "pageWorkers",
  "Scope Guard": "pageScope",
  "Event Ledger": "pageEvents",
  "Artifact Diff Viewer": "pageArtifacts",
  "Recovery Center": "pageRecovery"
};

export function CommandCenter({ data, meta, api, stale, onRefresh, locale, localeSetting, onLocaleSettingChange, themeSetting, effectiveTheme, onThemeSettingChange, actionMessage }: CommandCenterProps): JSX.Element {
  const [page, setPage] = useState<Page>("Mission Control");
  const [note, setNote] = useState("");
  const [gateNextState, setGateNextState] = useState("");
  const [busyAction, setBusyAction] = useState<string>();
  const [artifactPreview, setArtifactPreview] = useState<{ id: string; text: string; error?: string; truncated?: boolean }>();
  const stableApi = useRef(api);
  const dismissedOneShotNotifications = useRef(new Set<string>());
  useEffect(() => {
    stableApi.current = api;
  }, [api]);

  const run = data.current.run;
  const activeGate = data.gates.find((gate) => gate.status === "open" && gate.activity === "active");
  const historicalOpenGate = data.gates.find((gate) => gate.status === "open" && gate.activity === "historical");
  const notifications = data.notifications ?? [];
  const attention = highestAttention(notifications, activeGate?.kind ?? data.current.gate?.kind, locale);
  const selectedArtifact = data.artifacts[0];
  const gateNextStates = allowedGateNextStates(activeGate);
  const gateDecisionPayload = gateNextState ? { nextState: gateNextState } : {};

  useEffect(() => {
    setNote("");
    setGateNextState(defaultGateNextState(activeGate));
  }, [activeGate?.id]);

  useEffect(() => {
    const oneShotIds = notifications
      .map((notification) => notification.id)
      .filter((id) => id.startsWith("longrunning:") && !dismissedOneShotNotifications.current.has(id));
    if (oneShotIds.length === 0) {
      return;
    }
    for (const id of oneShotIds) {
      dismissedOneShotNotifications.current.add(id);
    }
    void stableApi.current.mutate("/api/notifications/dismiss", { notificationIds: oneShotIds }).then((result) => {
      if (result.ok) {
        onRefresh();
        return;
      }
      for (const id of oneShotIds) {
        dismissedOneShotNotifications.current.delete(id);
      }
    });
  }, [notifications, onRefresh]);

  const runAction = async <T = unknown,>(label: string, path: string, body?: unknown): Promise<DashboardResult<T>> => {
    setBusyAction(label);
    try {
      // Mutating endpoints return route-specific payloads; callers validate any narrowed shape before use.
      const result = await stableApi.current.mutate(path, body) as DashboardResult<T>;
      onRefresh();
      return result;
    } finally {
      setBusyAction(undefined);
    }
  };

  const pageContent = useMemo(() => {
    if (page === "Plan Navigator") return <PlanNavigatorSection data={data.plan} selection={data.selection} locale={locale} />;
    if (page === "Policy Config") return <PolicyConfigSection api={stableApi.current} onRefresh={onRefresh} locale={locale} />;
    if (page === "Dry-run Preview") return <DryRunPreviewSection api={stableApi.current} locale={locale} onAction={(path) => void runAction(path, path)} />;
    if (page === "Notifications") return <NotificationsSection notifications={notifications} api={stableApi.current} onRefresh={onRefresh} locale={locale} />;
    if (page === "Agent Timeline") return <AgentTimelineSection api={stableApi.current} {...(data.current.run?.id ? { runId: data.current.run.id } : {})} locale={locale} />;
    if (page === "Gate Center") return <GateCenterSection data={data} locale={locale} />;
    if (page === "PR Inbox") return <PrInboxSection data={data} locale={locale} />;
    if (page === "Worker Runs") return <WorkerRunsSection workers={data.workers} api={stableApi.current} locale={locale} scopeNote={workerScopeSummary(data.workers, locale)} />;
    if (page === "Scope Guard") return <ScopeGuardSection data={data} locale={locale} />;
    if (page === "Event Ledger") return <EventLedgerSection events={data.events} locale={locale} />;
    if (page === "Artifact Diff Viewer") return <ArtifactViewerSection api={stableApi.current} data={data} preview={artifactPreview} onPreview={setArtifactPreview} locale={locale} />;
    if (page === "Recovery Center") {
      return (
        <RecoveryCenterSection
          data={data}
          stale={stale}
          onRecover={() => void runAction("recover", "/api/recover")}
          onReevaluateGate={(gateId) => runAction<GateReevaluationData>("re-evaluate", `/api/gates/${gateId}/re-evaluate`)}
          onMarkGateHandled={(gateId) => void runAction("mark-handled", `/api/gates/${gateId}/mark-handled`)}
          locale={locale}
        />
      );
    }
    return <MissionControlSection data={data} api={stableApi.current} stale={stale} locale={locale} onNavigate={setPage} />;
  }, [artifactPreview, data, locale, notifications, onRefresh, page, stale]);

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="dashboard-brand">
          <div className="brand-mark"><BrandMark /></div>
          <div>
            <strong>{t(locale, "brandTitle")}</strong>
            <span>{t(locale, "brandSubtitle")}</span>
          </div>
        </div>
        <nav className="nav-list" aria-label={t(locale, "navAria")}>
          {pages.map((item) => {
            const Icon = item.icon;
            const label = t(locale, pageKeys[item.name]);
            return (
              <button
                aria-label={label}
                className={item.name === page ? "nav-item is-active" : "nav-item"}
                key={item.name}
                title={label}
                type="button"
                onClick={() => setPage(item.name)}
              >
                <Icon size={17} />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer-compact" aria-label={`${t(locale, "language")} / ${t(locale, "theme")}`}>
          <label className="compact-icon-control compact-icon-control--select" title={`${t(locale, "language")}: ${localeOptionLabel(locale, localeSetting)}`}>
            <Languages size={17} />
            <select
              aria-label={`${t(locale, "language")}: ${localeOptionLabel(locale, localeSetting)}`}
              value={localeSetting}
              onChange={(event) => onLocaleSettingChange(event.target.value as LocaleSetting)}
            >
              {LOCALE_SETTINGS.map((option) => <option key={option} value={option}>{localeOptionLabel(locale, option)}</option>)}
            </select>
          </label>
          <div className="compact-theme-switcher" role="group" aria-label={t(locale, "theme")}>
            {THEME_SETTINGS.map((option) => {
              const Icon = themeIcon(option);
              const label = themeOptionLabel(locale, option);
              return (
                <button
                  aria-label={`${t(locale, "theme")}: ${label}`}
                  aria-pressed={themeSetting === option}
                  className={themeSetting === option ? "compact-icon-control is-active" : "compact-icon-control"}
                  key={option}
                  title={`${label} / ${t(locale, "themeEffective")}: ${themeOptionLabel(locale, effectiveTheme)}`}
                  type="button"
                  onClick={() => onThemeSettingChange(option)}
                >
                  <Icon size={17} />
                </button>
              );
            })}
          </div>
          <div className="compact-icon-control" title={`${meta?.targetRepo?.repoId ?? run?.branch ?? data.pr?.branch ?? t(locale, "noActiveBranch")} / ${stale ? t(locale, "stale") : t(locale, "live")}`}>
            <Boxes size={17} />
            <span className={stale ? "compact-status-dot compact-status-dot--yellow" : "compact-status-dot compact-status-dot--green"} />
          </div>
        </div>
        <div className="sidebar-footer">
          <label className="locale-switcher">
            <span>{t(locale, "language")}</span>
            <select
              aria-label={t(locale, "language")}
              value={localeSetting}
              onChange={(event) => onLocaleSettingChange(event.target.value as LocaleSetting)}
            >
              {LOCALE_SETTINGS.map((option) => <option key={option} value={option}>{localeOptionLabel(locale, option)}</option>)}
            </select>
          </label>
          <div className="theme-switcher" aria-label={t(locale, "theme")}>
            <span>{t(locale, "theme")}</span>
            <div className="segmented-control" role="group" aria-label={t(locale, "theme")}>
              {THEME_SETTINGS.map((option) => {
                const Icon = themeIcon(option);
                const label = themeOptionLabel(locale, option);
                return (
                  <button
                    aria-pressed={themeSetting === option}
                    className={themeSetting === option ? "segmented-button is-active" : "segmented-button"}
                    key={option}
                    title={`${label} / ${t(locale, "themeEffective")}: ${themeOptionLabel(locale, effectiveTheme)}`}
                    type="button"
                    onClick={() => onThemeSettingChange(option)}
                  >
                    <Icon size={16} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="repo-chip repo-chip--stacked" title={meta?.targetRepo?.root}>
            <Boxes size={18} />
            <span>{meta?.targetRepo?.repoId ?? run?.branch ?? data.pr?.branch ?? t(locale, "noActiveBranch")}</span>
            {meta?.targetRepo?.root ? <small>{meta.targetRepo.root}</small> : null}
          </div>
          <StatusBadge value={stale ? t(locale, "stale") : t(locale, "live")} tone={stale ? "yellow" : "green"} />
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="topbar">
          <TopMetric icon={GitBranch} label={t(locale, "topCurrentState")} value={run?.currentState ?? data.current.status} tone={toneForStatus(data.current.status)} locale={locale} />
          <TopMetric icon={Activity} label={t(locale, "topAutonomy")} value={data.autonomy?.autonomyMode ?? "default"} tone="blue" locale={locale} />
          <TopMetric
            icon={GitPullRequest}
            label={data.profile?.loopShape === "generic-loop" ? t(locale, "fieldLoopShape") : t(locale, "topMerge")}
            value={data.profile?.loopShape === "generic-loop" ? data.profile.loopShape : data.mergeReadiness?.state ?? data.autonomy?.mergeMode ?? "manual"}
            tone={data.profile?.loopShape === "generic-loop" || data.mergeReadiness?.ready ? "green" : "yellow"}
            locale={locale}
          />
          <TopMetric icon={Bell} label={t(locale, "topAttention")} value={String(notifications.filter((item) => item.severity !== "informational").length)} tone={notifications.some((item) => item.severity === "blocked") ? "red" : "yellow"} />
          <TopMetric icon={Clock3} label={t(locale, "topPolling")} value={stale ? t(locale, "stale") : t(locale, "live")} tone={stale ? "yellow" : "green"} />
        </header>

        <section className="workspace">
          <div className="dashboard-content">
            <div className="section-heading">
              <div>
                <h1>{t(locale, pageKeys[page])}</h1>
                <p>{subtitleFor(page, locale)}</p>
              </div>
              <div className="heading-actions">
                {actionMessage ? <span className="action-message">{actionMessage}</span> : null}
                <button className="ghost-button" type="button" onClick={onRefresh}>{t(locale, "actionRefresh")}</button>
              </div>
            </div>
            {pageContent}
          </div>

          <aside className="intervention-panel" aria-label={t(locale, "interventionPanel")}>
            <div className="inspector-section">
              <p className="eyebrow">{t(locale, "interventionPanelEyebrow")}</p>
              <div className="gate-title">
                {attention.risk === "high" ? <AlertTriangle size={26} /> : <CheckCircle2 size={26} />}
                <div>
                  <h2>{attention.title}</h2>
                  <RiskBadge risk={attention.risk} locale={locale} />
                </div>
              </div>
              <dl className="detail-list">
                <div><dt>{t(locale, "runId")}</dt><dd>{run?.id ?? t(locale, "none")}</dd></div>
                <div><dt>{t(locale, "gateId")}</dt><dd>{activeGate?.id ?? historicalOpenGate?.id ?? t(locale, "none")}</dd></div>
                <div>
                  <dt>{t(locale, "tableActivity")}</dt>
                  <dd>
                    {activeGate ? (
                      <ActivityBadge activity={activeGate.activity} reason={activeGate.activityReason} locale={locale} />
                    ) : historicalOpenGate ? (
                      <>
                        <ActivityBadge activity={historicalOpenGate.activity} reason={historicalOpenGate.activityReason} locale={locale} />
                        <span className="inline-detail">{activityReasonLabel(locale, historicalOpenGate.activityReason)}</span>
                      </>
                    ) : t(locale, "none")}
                  </dd>
                </div>
                <div><dt>{t(locale, "reason")}</dt><dd>{attention.reason}</dd></div>
                <div><dt>{t(locale, "updated")}</dt><dd>{run ? formatTime(run.updatedAt) : t(locale, "notStarted")}</dd></div>
              </dl>
            </div>

            <div className="inspector-section">
              <p className="eyebrow">{t(locale, "decisionNoteEyebrow")}</p>
              <textarea aria-label={t(locale, "decisionNote")} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t(locale, "decisionNotePlaceholder")} />
              {gateNextStates.length > 0 ? (
                <label>
                  {t(locale, "gateNextState")}
                  <select aria-label={t(locale, "gateNextState")} value={gateNextState} onChange={(event) => setGateNextState(event.target.value)}>
                    {gateNextStates.map((state) => <option key={state} value={state}>{displayValueLabel(locale, state)}</option>)}
                  </select>
                </label>
              ) : null}
              <div className="button-row">
                <button className="success-button" disabled={!activeGate || note.trim().length === 0 || busyAction !== undefined} type="button" onClick={() => activeGate && runAction("approve", `/api/gates/${activeGate.id}/approve`, { note, source: "ui", payload: gateDecisionPayload })}>
                  <CheckCircle2 size={16} /> {t(locale, "actionApprove")}
                </button>
                <button className="danger-button" disabled={!activeGate || note.trim().length === 0 || busyAction !== undefined} type="button" onClick={() => activeGate && runAction("reject", `/api/gates/${activeGate.id}/reject`, { note, source: "ui", payload: {} })}>
                  <AlertTriangle size={16} /> {t(locale, "actionReject")}
                </button>
              </div>
            </div>

            <div className="inspector-section">
              <p className="eyebrow">{t(locale, "loopControls")}</p>
              <div className="control-grid">
                <button type="button" onClick={() => runAction("run", "/api/run-until-gate")} disabled={busyAction !== undefined}><Play size={16} /> {t(locale, "actionRunToGate")}</button>
                <button type="button" onClick={() => runAction("step", "/api/step")} disabled={busyAction !== undefined}><StepForward size={16} /> {t(locale, "actionStep")}</button>
                <button type="button" onClick={() => runAction("resume", "/api/resume")} disabled={busyAction !== undefined}><RotateCcw size={16} /> {t(locale, "actionResume")}</button>
                <button type="button" onClick={() => runAction("stop", "/api/stop")} disabled={busyAction !== undefined}><CircleStop size={16} /> {t(locale, "actionStop")}</button>
              </div>
            </div>

            <div className="inspector-section">
              <p className="eyebrow">{t(locale, "artifactShortcut")}</p>
              <div className="artifact-shortcut"><FileText size={17} /><span>{selectedArtifact?.name ?? t(locale, "noArtifactsYet")}</span></div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}


function allowedGateNextStates(gate: GateSummary | undefined): string[] {
  const details = gateDetails(gate);
  const states = details?.allowedNextStates;
  return Array.isArray(states) ? states.filter((state): state is string => typeof state === "string") : [];
}

function defaultGateNextState(gate: GateSummary | undefined): string {
  const details = gateDetails(gate);
  const defaultState = details?.defaultNextState;
  if (typeof defaultState === "string") return defaultState;
  return allowedGateNextStates(gate)[0] ?? "";
}

function gateDetails(gate: GateSummary | undefined): Record<string, unknown> | undefined {
  const details = gate?.details;
  return typeof details === "object" && details !== null && !Array.isArray(details) ? details as Record<string, unknown> : undefined;
}


function highestAttention(notifications: LoopNotification[], gate: string | undefined, locale: EffectiveLocale): { title: string; reason: string; risk: "low" | "medium" | "high" } {
  const blocker = notifications.find((item) => item.severity === "blocked" || item.severity === "confirmation_required");
  if (blocker) return { title: blocker.title, reason: blocker.reason, risk: "high" };
  const attention = notifications.find((item) => item.severity === "attention");
  if (attention) return { title: attention.title, reason: attention.reason, risk: "medium" };
  if (gate) return { title: gate, reason: t(locale, "visibleGateReason"), risk: "medium" };
  return { title: t(locale, "noInterventionTitle"), reason: t(locale, "noInterventionReason"), risk: "low" };
}

function subtitleFor(page: Page, locale: EffectiveLocale): string {
  const map: Record<Page, string> = {
    "Mission Control": "subtitleMission",
    "Plan Navigator": "subtitlePlan",
    "Policy Config": "subtitlePolicy",
    "Dry-run Preview": "subtitleDryRun",
    "Notifications": "subtitleNotifications",
    "Agent Timeline": "subtitleTimeline",
    "Gate Center": "subtitleGates",
    "PR Inbox": "subtitlePr",
    "Worker Runs": "subtitleWorkers",
    "Scope Guard": "subtitleScope",
    "Event Ledger": "subtitleEvents",
    "Artifact Diff Viewer": "subtitleArtifacts",
    "Recovery Center": "subtitleRecovery"
  };
  return t(locale, map[page]);
}

export { decodeBase64Preview } from "./CommandCenterParts.js";

function themeIcon(theme: ThemeSetting): typeof Sun {
  if (theme === "light") return Sun;
  if (theme === "dark") return Moon;
  return Monitor;
}
