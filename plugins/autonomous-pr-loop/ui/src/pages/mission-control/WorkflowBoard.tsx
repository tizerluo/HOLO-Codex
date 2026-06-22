import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Link2, PlusCircle, X } from "lucide-react";
import type { CSSProperties, JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DashboardApi,
  WorkflowBoard,
  WorkflowBoardStage,
  WorkflowCheckRow,
  WorkflowDrillDownTarget,
  WorkflowEvidenceRef,
  WorkflowReviewReportRow,
  WorkflowStageId,
  WorkflowStageStatus
} from "../../api.js";
import { StatusBadge, type StatusTone } from "../../components/StatusBadge.js";
import { displayValueLabel, t } from "../../i18n.js";
import { formatTime, type EffectiveLocale } from "../CommandCenterParts.js";

interface WorkflowBoardViewProps {
  api: DashboardApi;
  runId?: string | undefined;
  refreshKey?: string | undefined;
  locale: EffectiveLocale;
  onEvidenceAppended: () => void;
  onNavigate?: (page: WorkflowDrillDownTarget["page"]) => void;
}

export function WorkflowBoardView({ api, runId, refreshKey, locale, onEvidenceAppended, onNavigate }: WorkflowBoardViewProps): JSX.Element {
  const [board, setBoard] = useState<WorkflowBoard>();
  const [error, setError] = useState<string>();
  const [selectedStageId, setSelectedStageId] = useState<WorkflowStageId>("work_item");
  const [collapsed, setCollapsed] = useState(false);
  const [peekStageId, setPeekStageId] = useState<WorkflowStageId>();
  const [peekPosition, setPeekPosition] = useState<{ left: number; top: number }>();
  const [summary, setSummary] = useState("");
  const [appending, setAppending] = useState(false);
  const [appendMessage, setAppendMessage] = useState<string>();
  const boardRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const peekCloseTimer = useRef<number | undefined>(undefined);
  const manualStageSelection = useRef(false);
  const boardRequestSeq = useRef(0);

  useEffect(() => {
    manualStageSelection.current = false;
  }, [runId]);

  useEffect(() => {
    let cancelled = false;
    const requestSeq = boardRequestSeq.current + 1;
    boardRequestSeq.current = requestSeq;
    if (!api.workflowBoard) {
      setError(t(locale, "workflowBoardLoadError"));
      return () => {
        cancelled = true;
      };
    }
    void api.workflowBoard(runId ? { runId } : undefined).then((result) => {
      if (cancelled || requestSeq !== boardRequestSeq.current) return;
      if (!result.ok || !result.data) {
        setError(result.error?.message ?? t(locale, "workflowBoardLoadError"));
        return;
      }
      if (!Array.isArray(result.data.stages)) {
        setError(t(locale, "workflowBoardLoadError"));
        return;
      }
      const nextBoard = result.data;
      setBoard(nextBoard);
      setSelectedStageId((current) => (
        manualStageSelection.current && nextBoard.stages.some((stage) => stage.id === current)
          ? current
          : nextBoard.activeStageId ?? nextBoard.selectedStageId
      ));
      setError(undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [api, locale, refreshKey, runId]);

  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setPeekStageId(undefined);
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      if (peekCloseTimer.current !== undefined) window.clearTimeout(peekCloseTimer.current);
    };
  }, []);

  const selectedStage = useMemo(
    () => board?.stages.find((stage) => stage.id === selectedStageId) ?? board?.stages[0],
    [board, selectedStageId]
  );
  const peekStage = board?.stages.find((stage) => stage.id === peekStageId);

  const openPeek = (stageId: WorkflowStageId, target?: HTMLElement): void => {
    if (peekCloseTimer.current !== undefined) window.clearTimeout(peekCloseTimer.current);
    if (target && boardRef.current) {
      const stageRect = target.getBoundingClientRect();
      const boardRect = boardRef.current.getBoundingClientRect();
      const minLeft = 180;
      const maxLeft = Math.max(minLeft, boardRect.width - minLeft);
      const centeredLeft = stageRect.left - boardRect.left + stageRect.width / 2;
      setPeekPosition({
        left: Math.min(Math.max(centeredLeft, minLeft), maxLeft),
        top: stageRect.top - boardRect.top - 12
      });
    }
    setPeekStageId(stageId);
  };
  const schedulePeekClose = (): void => {
    if (peekCloseTimer.current !== undefined) window.clearTimeout(peekCloseTimer.current);
    peekCloseTimer.current = window.setTimeout(() => setPeekStageId(undefined), 140);
  };

  useEffect(() => {
    const selected = railRef.current?.querySelector<HTMLElement>(`[data-stage-id="${selectedStageId}"]`);
    if (typeof selected?.scrollIntoView === "function") {
      selected.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [selectedStageId, board?.runId]);

  const appendEvidence = async (): Promise<void> => {
    if (!board || !selectedStage || summary.trim().length === 0) return;
    if (!api.appendWorkflowEvidence) {
      setAppendMessage(t(locale, "workflowEvidenceAppendFailed"));
      return;
    }
    setAppending(true);
    setAppendMessage(undefined);
    try {
      const result = await api.appendWorkflowEvidence({
        runId: board.runId,
        stageId: selectedStage.id,
        summary: summary.trim(),
        source: "dashboard",
        actor: "codex",
        status: "done"
      });
      if (result.ok) {
        setSummary("");
        setAppendMessage(t(locale, "workflowEvidenceAppended"));
        onEvidenceAppended();
        const refreshed = await api.workflowBoard?.(board.runId ? { runId: board.runId } : undefined);
        if (refreshed?.ok && refreshed.data) setBoard(refreshed.data);
        return;
      }
      setAppendMessage(result.error?.message ?? t(locale, "workflowEvidenceAppendFailed"));
    } finally {
      setAppending(false);
    }
  };

  if (error) {
    return <section className="workflow-board"><h2>{t(locale, "workflowBoardTitle")}</h2><p className="muted-copy">{error}</p></section>;
  }
  if (!board || !selectedStage) {
    return <section className="workflow-board"><h2>{t(locale, "workflowBoardTitle")}</h2><p className="muted-copy">{t(locale, "loadingPreviewMessage")}</p></section>;
  }

  return (
    <section className="workflow-board" aria-label={t(locale, "workflowBoardTitle")} ref={boardRef}>
      <div className="workflow-board__summary">
        <div>
          <p className="eyebrow">{t(locale, "workflowBoardTitle")}</p>
          <h2>{workItemTitle(board.workItem, t(locale, "workflowNoRun"))}</h2>
          <p>{board.message ?? t(locale, "workflowBoardSubtitle")}</p>
        </div>
        <div className="workflow-board__facts">
          <Fact label={t(locale, "runId")} value={board.workItem.runId ?? t(locale, "none")} />
          <Fact label={t(locale, "workflowStage")} value={selectedStage.label} />
          <Fact label={t(locale, "workflowStageSource")} value={stageSourceLabel(locale, board.stageSource)} />
          <Fact label={t(locale, "workflowRunState")} value={board.workItem.currentState ?? t(locale, "none")} />
          <Fact label={t(locale, "workflowHookCapture")} value={hookCaptureLabel(locale, board.hookCapture)} />
          {board.workItem.prNumber ? <Fact label="PR" value={`#${board.workItem.prNumber}`} /> : null}
          <Fact label={t(locale, "tableStatus")} value={statusLabel(locale, selectedStage.status)} />
          <Fact label={t(locale, "updated")} value={board.workItem.lastUpdate ? formatTime(board.workItem.lastUpdate) : t(locale, "notStarted")} />
          {board.stageSourceEvent ? <Fact label={t(locale, "workflowStageEvidence")} value={`${board.stageSourceEvent.id.slice(0, 8)} ${formatTime(board.stageSourceEvent.createdAt)}`} /> : null}
        </div>
      </div>

      <div className="workflow-rail" aria-label={t(locale, "workflowRail")} ref={railRef}>
        {board.stages.map((stage, index) => (
          <button
            className={`workflow-rail__stage workflow-rail__stage--${stage.status}${stage.id === selectedStage.id ? " is-selected" : ""}`}
            key={stage.id}
            data-stage-id={stage.id}
            type="button"
            onClick={(event) => {
              manualStageSelection.current = true;
              setSelectedStageId(stage.id);
              openPeek(stage.id, event.currentTarget);
            }}
            onFocus={(event) => openPeek(stage.id, event.currentTarget)}
            onBlur={schedulePeekClose}
            onMouseEnter={(event) => openPeek(stage.id, event.currentTarget)}
            onMouseLeave={schedulePeekClose}
            onPointerEnter={(event) => openPeek(stage.id, event.currentTarget)}
            onPointerLeave={schedulePeekClose}
          >
            <span className="workflow-rail__node" aria-hidden="true">{stage.status === "done" ? <CheckCircle2 size={15} /> : index + 1}</span>
            <span className="workflow-rail__label">{stage.label}</span>
            <span className="workflow-rail__meta">
              <StatusBadge value={statusLabel(locale, stage.status)} tone={toneForWorkflowStatus(stage.status)} />
              <small>{evidenceTotal(stage.evidenceCounts)} {t(locale, "workflowEvidenceShort")}</small>
            </span>
          </button>
        ))}
      </div>

      {peekStage ? (
        <div
          className="workflow-peek"
          role="dialog"
          aria-label={peekStage.label}
          style={peekPosition ? ({ "--workflow-peek-left": `${peekPosition.left}px`, "--workflow-peek-top": `${peekPosition.top}px` } as CSSProperties) : undefined}
          onMouseEnter={() => openPeek(peekStage.id)}
          onMouseLeave={schedulePeekClose}
        >
          <button className="icon-button" type="button" onClick={() => setPeekStageId(undefined)} aria-label={t(locale, "actionClose")}><X size={16} /></button>
          <h3>{peekStage.label}</h3>
          <p>{peekStage.nextAction}</p>
          <EvidenceList refs={stageEvidence(board, peekStage)} locale={locale} compact {...(onNavigate ? { onNavigate } : {})} />
        </div>
      ) : null}

      <div className="workflow-board__body">
        <aside className={collapsed ? "workflow-inspector is-collapsed" : "workflow-inspector"}>
          <div className="workflow-inspector__control">
            <button
              className="icon-button workflow-inspector__toggle"
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              aria-label={collapsed ? t(locale, "workflowInspectorOpen") : t(locale, "workflowInspectorCollapse")}
              title={collapsed ? t(locale, "workflowInspectorOpen") : t(locale, "workflowInspectorCollapse")}
            >
              {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
            </button>
          </div>
          {collapsed ? (
            <div className="workflow-inspector__collapsed" aria-label={selectedStage.label} title={selectedStage.label}>
              <span className={`workflow-inspector__dot workflow-inspector__dot--${selectedStage.status}`} aria-hidden="true" />
            </div>
          ) : (
            <div className="workflow-inspector__stage">
              <div className="workflow-inspector__heading">
                <div>
                  <strong>{selectedStage.label}</strong>
                </div>
                <StatusBadge value={statusLabel(locale, selectedStage.status)} tone={toneForWorkflowStatus(selectedStage.status)} />
              </div>
              <p className="workflow-inspector__hint">{selectedStage.latestAction?.label ?? selectedStage.nextAction}</p>
              <ul>
                {selectedStage.substages.map((substage) => (
                  <li key={substage.id}>
                    <span>{substage.label}</span>
                    <span className="workflow-inspector__submeta">
                      <StatusBadge value={statusLabel(locale, substage.status)} tone={toneForWorkflowStatus(substage.status)} />
                      <small>{evidenceTotal(substage.evidenceCounts)} {t(locale, "workflowEvidenceShort")}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <main className="workflow-detail">
          <div className="workflow-detail__header">
            <div>
              <p className="eyebrow">{t(locale, "workflowCurrentStage")}</p>
              <h3>{selectedStage.label}</h3>
              <p>{selectedStage.nextAction}</p>
            </div>
            <div className="workflow-detail__side">
              <StatusBadge value={statusLabel(locale, selectedStage.status)} tone={toneForWorkflowStatus(selectedStage.status)} />
              <div className="actor-chip-row">
                {selectedStage.actorChips.map((actor) => <span className="actor-chip" key={`${selectedStage.id}-${actor.actor}`}>{actor.label}<small>{statusLabel(locale, actor.status)}</small></span>)}
              </div>
            </div>
          </div>

          {selectedStage.blockers.length ? (
            <div className="workflow-blocker">
              <AlertTriangle size={18} />
              <div>
                <strong>{selectedStage.blockers[0]?.title}</strong>
                <p>{selectedStage.blockers[0]?.reason}</p>
                <dl>
                  <dt>{t(locale, "owner")}</dt>
                  <dd>{selectedStage.blockers[0]?.owner}</dd>
                  <dt>{t(locale, "workflowNextAction")}</dt>
                  <dd>{selectedStage.blockers[0]?.nextAction}</dd>
                </dl>
              </div>
            </div>
          ) : null}

          <StageSpecificDetail board={board} stage={selectedStage} locale={locale} />

          {board.appendEvidenceEnabled ? (
            <div className="workflow-append">
              <label>
                {t(locale, "workflowAttachEvidence")}
                <textarea value={summary} maxLength={280} onChange={(event) => setSummary(event.target.value)} placeholder={t(locale, "workflowEvidencePlaceholder")} />
              </label>
              <div className="button-row">
                <button type="button" disabled={appending || summary.trim().length === 0} onClick={() => void appendEvidence()}>
                  <PlusCircle size={16} /> {t(locale, "workflowAttachEvidence")}
                </button>
                {appendMessage ? <span className="action-message">{appendMessage}</span> : null}
              </div>
            </div>
          ) : null}

          <div className="workflow-evidence">
            <h4>{t(locale, "workflowEvidence")}</h4>
            <EvidenceList refs={stageEvidence(board, selectedStage)} locale={locale} {...(onNavigate ? { onNavigate } : {})} />
          </div>
        </main>
      </div>
    </section>
  );
}

function StageSpecificDetail({ board, stage, locale }: { board: WorkflowBoard; stage: WorkflowBoardStage; locale: EffectiveLocale }): JSX.Element {
  if (stage.id === "verify") return <CheckTable title={t(locale, "workflowVerifyMatrix")} rows={board.verificationChecks} locale={locale} />;
  if (stage.id === "review") return <ReviewMatrix rows={board.reviewReports} locale={locale} />;
  if (stage.id === "merge_readiness") {
    return (
      <CheckTable
        title={t(locale, "workflowMergeChecklist")}
        rows={board.mergeReadinessChecks}
        locale={locale}
        note={t(locale, "workflowGithubMergeNote")}
        action={board.workItem.prUrl ? { href: board.workItem.prUrl, label: t(locale, "workflowOpenGithubPr") } : undefined}
      />
    );
  }
  if (stage.id === "cleanup") return <CheckTable title={t(locale, "workflowCleanupChecklist")} rows={board.cleanupChecks} locale={locale} />;
  if (stage.id === "pr") {
    return (
      <CheckTable
        title={t(locale, "workflowPrChecklist")}
        rows={[
          { id: "pr-opened", label: t(locale, "workflowPrOpened"), status: board.workItem.prUrl ? "passed" : "pending", evidence: board.workItem.prUrl ?? t(locale, "notLinked"), owner: "GitHub" }
        ]}
        locale={locale}
        note={t(locale, "workflowGithubPrNote")}
        action={board.workItem.prUrl ? { href: board.workItem.prUrl, label: t(locale, "workflowOpenGithubPr") } : undefined}
      />
    );
  }
  return (
    <div className="workflow-stage-card">
      <h4>{t(locale, "workflowStageSummary")}</h4>
      <p>{stage.latestAction?.label ?? stage.nextAction}</p>
    </div>
  );
}

function CheckTable({
  title,
  rows,
  locale,
  note,
  action
}: {
  title: string;
  rows: WorkflowCheckRow[];
  locale: EffectiveLocale;
  note?: string | undefined;
  action?: { href: string; label: string } | undefined;
}): JSX.Element {
  return (
    <div className="workflow-matrix">
      <h4>{title}</h4>
      {note ? (
        <p className="workflow-matrix__note">
          <span>{note}</span>
          {action ? <a href={action.href} target="_blank" rel="noreferrer">{action.label}</a> : null}
        </p>
      ) : null}
      <div className="workflow-matrix__rows">
        {rows.length === 0 ? <p className="muted-copy">{t(locale, "noneList")}</p> : rows.map((row) => (
          <div className="workflow-matrix__row" key={row.id}>
            <span>{row.label}</span>
            <StatusBadge value={displayValueLabel(locale, row.status)} tone={toneForCheck(row.status)} />
            <span>{row.evidence}</span>
            <small>{row.owner}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewMatrix({ rows, locale }: { rows: WorkflowReviewReportRow[]; locale: EffectiveLocale }): JSX.Element {
  return (
    <div className="workflow-matrix workflow-matrix--review">
      <h4>{t(locale, "workflowReviewMatrix")}</h4>
      <div className="workflow-matrix__rows">
        <div className="workflow-matrix__row workflow-matrix__row--header workflow-matrix__row--review">
          <span>{t(locale, "workflowReviewer")}</span>
          <span>{t(locale, "workflowReviewerRole")}</span>
          <span>{t(locale, "workflowProgress")}</span>
          <span>{t(locale, "workflowResult")}</span>
          <span>{t(locale, "workflowFindings")}</span>
          <span>{t(locale, "workflowResolution")}</span>
        </div>
        {rows.map((row) => (
          <div className="workflow-matrix__row workflow-matrix__row--review" key={row.id}>
            <span>
              <strong>{row.agent}</strong>
              <small>{displayValueLabel(locale, row.requirement ?? "unknown")}</small>
            </span>
            <span>
              <strong>{row.role}</strong>
              <small>{row.backend ?? row.model ?? t(locale, "none")}</small>
            </span>
            <span>
              <StatusBadge value={displayValueLabel(locale, row.progress ?? "unknown")} tone={toneForProgress(row.progress ?? "unknown", row.status)} />
              <small>{row.progress === "incomplete" ? row.nextAction ?? row.resolutionEvidence : row.nextAction}</small>
            </span>
            <span>
              <StatusBadge value={displayValueLabel(locale, row.result ?? row.status)} tone={toneForReview(row.status)} />
              <small>{row.severitySummary}</small>
            </span>
            <span className="review-finding-list">
              {row.severityGroups.map((group) => (
                <span className={`review-finding review-finding--${group.status}`} key={`${row.id}-${group.id}`} title={group.evidence}>
                  {group.label}
                </span>
              ))}
              {row.followUp ? <small>{row.followUp}</small> : null}
            </span>
            <span>
              {row.commentUrl ? <a href={row.commentUrl} target="_blank" rel="noopener noreferrer">{displayValueLabel(locale, row.prComment)}</a> : <strong>{displayValueLabel(locale, row.prComment)}</strong>}
              <small>{displayValueLabel(locale, row.resolutionStatus)}: {row.resolutionEvidence}</small>
              <small>{reviewEvidenceSummary(row, locale)}</small>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function reviewEvidenceSummary(row: WorkflowReviewReportRow, locale: EffectiveLocale): string {
  const refs = [
    row.model ? `model: ${row.model}` : undefined,
    row.sessionId ? `session: ${row.sessionId}` : undefined,
    row.conversationId ? `conversation: ${row.conversationId}` : undefined,
    row.commentId ? `comment: ${row.commentId}` : undefined
  ].filter((item): item is string => Boolean(item));
  return refs.length > 0 ? refs.join(" / ") : row.nextAction ?? row.reason ?? row.followUp ?? t(locale, "none");
}

function EvidenceList({
  refs,
  locale,
  compact = false,
  onNavigate
}: {
  refs: WorkflowEvidenceRef[];
  locale: EffectiveLocale;
  compact?: boolean;
  onNavigate?: (page: WorkflowDrillDownTarget["page"]) => void;
}): JSX.Element {
  const [preview, setPreview] = useState<WorkflowEvidenceRef>();
  if (refs.length === 0) return <p className="muted-copy">{t(locale, "workflowNoEvidence")}</p>;
  return (
    <div className={compact ? "workflow-evidence-list workflow-evidence-list--compact" : "workflow-evidence-list"}>
      {refs.slice(0, compact ? 4 : 8).map((ref) => (
        <button
          className={`workflow-evidence-chip workflow-evidence-chip--${ref.interaction}`}
          key={ref.id}
          title={ref.summary}
          type="button"
          onClick={() => {
            if (ref.interaction === "drill_down_link" && ref.drillDownTarget && onNavigate) {
              onNavigate(ref.drillDownTarget.page);
              return;
            }
            setPreview(preview?.id === ref.id ? undefined : ref);
          }}
        >
          {ref.interaction === "drill_down_link" ? <Link2 size={14} /> : <Info size={14} />}
          <strong>{ref.label}</strong>
          <small>{ref.summary}</small>
        </button>
      ))}
      {preview ? (
        <div className="workflow-evidence-preview" role="dialog" aria-label={preview.label}>
          <button className="icon-button" type="button" onClick={() => setPreview(undefined)} aria-label={t(locale, "actionClose")}><X size={14} /></button>
          <strong>{preview.label}</strong>
          <p>{preview.summary}</p>
          <dl>
            <dt>{t(locale, "tableKind")}</dt>
            <dd>{preview.kind}</dd>
            <dt>{t(locale, "workflowEvidenceTarget")}</dt>
            <dd>{preview.drillDownTarget?.page ?? preview.interaction}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function stageEvidence(board: WorkflowBoard, stage: WorkflowBoardStage): WorkflowEvidenceRef[] {
  return board.evidenceRefs.filter((ref) => ref.source === stage.id || ref.id.startsWith(`${stage.id}:`));
}

function evidenceTotal(counts: { events: number; artifacts: number; gates: number; prComments: number; gitnexus: number; browser: number; ci: number; reports: number }): number {
  return counts.events + counts.artifacts + counts.gates + counts.prComments + counts.gitnexus + counts.browser + counts.ci + counts.reports;
}

function workItemTitle(workItem: {
  issueNumber?: number | undefined;
  issueTitle?: string | undefined;
  prNumber?: number | undefined;
  branch?: string | undefined;
  runId?: string | undefined;
}, fallback: string): string {
  if (workItem.issueNumber && workItem.issueTitle) return `#${workItem.issueNumber} ${workItem.issueTitle}`;
  if (workItem.issueNumber) return `#${workItem.issueNumber}`;
  if (workItem.prNumber) return `PR #${workItem.prNumber}`;
  return workItem.branch ?? workItem.runId ?? fallback;
}

function statusLabel(locale: EffectiveLocale, status: WorkflowStageStatus): string {
  return displayValueLabel(locale, status);
}

function stageSourceLabel(locale: EffectiveLocale, source: WorkflowBoard["stageSource"]): string {
  return displayValueLabel(locale, source ?? "unknown");
}

function hookCaptureLabel(locale: EffectiveLocale, capture: WorkflowBoard["hookCapture"]): string {
  if (!capture) return t(locale, "unknown");
  const reasons: Record<string, { "en-US": string; "zh-CN": string }> = {
    captured: { "en-US": "recent hook event observed", "zh-CN": "最近有 hook 事件" },
    not_seen: { "en-US": "current session not observed", "zh-CN": "当前线程未观察到" },
    stale: { "en-US": "last hook event is stale", "zh-CN": "最近未观察到" },
    ambiguous: { "en-US": "multiple bindings match", "zh-CN": "绑定不唯一" },
    unavailable: { "en-US": "no usable binding", "zh-CN": "无可用绑定" }
  };
  return `${displayValueLabel(locale, capture.status)} - ${reasons[capture.status]?.[locale] ?? capture.reason}`;
}

function toneForWorkflowStatus(status: WorkflowStageStatus): StatusTone {
  if (status === "done") return "green";
  if (status === "blocked" || status === "failed") return "red";
  if (status === "active" || status === "manual") return "yellow";
  if (status === "skipped") return "blue";
  return "muted";
}

function toneForCheck(status: WorkflowCheckRow["status"]): StatusTone {
  if (status === "passed") return "green";
  if (status === "failed" || status === "blocked") return "red";
  if (status === "pending") return "yellow";
  if (status === "skipped") return "blue";
  return "muted";
}

function toneForReview(status: WorkflowReviewReportRow["status"]): StatusTone {
  if (status === "pass") return "green";
  if (status === "block") return "red";
  if (status === "warn") return "yellow";
  if (status === "pending") return "yellow";
  if (status === "skipped") return "blue";
  return "muted";
}

function toneForRequirement(requirement: NonNullable<WorkflowReviewReportRow["requirement"]>): StatusTone {
  if (requirement === "required") return "yellow";
  if (requirement === "not_required") return "blue";
  if (requirement === "optional") return "muted";
  return "muted";
}

function toneForProgress(progress: NonNullable<WorkflowReviewReportRow["progress"]>, status: WorkflowReviewReportRow["status"]): StatusTone {
  if (progress === "complete") return status === "block" ? "red" : "green";
  if (progress === "incomplete") return "red";
  if (progress === "requested" || progress === "started" || progress === "in_progress") return "yellow";
  if (progress === "skipped") return "blue";
  return "muted";
}
