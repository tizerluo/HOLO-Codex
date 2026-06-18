import type { JSX } from "react";
import type { MissionControlData } from "../../api.js";
import { Collapsible } from "../../components/Collapsible.js";
import { MetricRow } from "../../components/MetricRow.js";
import { ResponsiveTable } from "../../components/ResponsiveTable.js";
import { StatusBadge, toneForStatus } from "../../components/StatusBadge.js";
import { displayValueLabel, t } from "../../i18n.js";
import { formatTime, type EffectiveLocale } from "../CommandCenterParts.js";

export function PrInbox({ data, locale }: { data: MissionControlData; locale: EffectiveLocale }): JSX.Element {
  return (
    <div className="two-stack">
      <section className="pr-summary">
        <MetricRow label={t(locale, "tablePullRequest")} value={data.pr ? `#${data.pr.prNumber} ${data.pr.state}` : t(locale, "none")} tone={data.pr ? "blue" : "muted"} />
        <MetricRow label={t(locale, "tableDraft")} value={data.pr?.draft ? t(locale, "draft") : data.pr ? t(locale, "ready") : t(locale, "unknown")} tone={data.pr?.draft ? "yellow" : data.pr ? "green" : "muted"} />
        <MetricRow label={t(locale, "tableBranch")} value={data.pr?.branch ?? t(locale, "notLinked")} tone={data.pr ? "blue" : "muted"} />
      </section>
      <Collapsible title={t(locale, "reviewComments")} chip={t(locale, "commentsChip", { count: data.reviewComments.length })} defaultOpen>
        <ResponsiveTable columns={[t(locale, "tableComment"), t(locale, "tableAuthor"), t(locale, "tablePath"), t(locale, "tableStatus")]} rows={data.reviewComments.map((comment) => ({ key: comment.id, cells: [comment.body, comment.author, comment.path, <StatusBadge key={comment.id} value={displayValueLabel(locale, comment.status)} tone={toneForStatus(comment.status)} />], cardTitle: comment.body, cardMeta: comment.path, cardSummary: comment.author }))} empty={t(locale, "noReviewComments")} />
      </Collapsible>
      <Collapsible title={t(locale, "ciChecks")} chip={t(locale, "checksChip", { count: data.ci.length })} defaultOpen>
        <ResponsiveTable columns={[t(locale, "tableCheck"), t(locale, "tableStatus"), t(locale, "tableConclusion"), t(locale, "tableObserved")]} rows={data.ci.map((check) => ({ key: check.id, cells: [check.name, check.status, check.conclusion ?? t(locale, "pending"), formatTime(check.observedAt)], cardTitle: check.name, cardMeta: formatTime(check.observedAt), cardSummary: check.conclusion ?? check.status }))} empty={t(locale, "noCiChecks")} />
      </Collapsible>
    </div>
  );
}
