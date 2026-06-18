import type { JSX } from "react";
import type { MissionControlData } from "../../api.js";
import { ActivityBadge, activityReasonLabel } from "../../components/ActivityBadge.js";
import { ResponsiveTable } from "../../components/ResponsiveTable.js";
import { StatusBadge, toneForStatus } from "../../components/StatusBadge.js";
import { displayValueLabel, t } from "../../i18n.js";
import { RawMessageDetails, formatTime, summarizeRawMessage, type EffectiveLocale } from "../CommandCenterParts.js";

export function GateCenter({ data, locale }: { data: MissionControlData; locale: EffectiveLocale }): JSX.Element {
  const active = data.gates.filter((gate) => gate.activity === "active").length;
  const historical = data.gates.filter((gate) => gate.activity === "historical").length;
  return (
    <div className="two-stack">
      <p className="scope-note">{t(locale, "gateScopeSummary", { active, historical, total: data.gates.length })}</p>
      <ResponsiveTable
        columns={[t(locale, "tableGate"), t(locale, "tableActivity"), t(locale, "tableStatus"), t(locale, "tableRawMessage"), t(locale, "tableOpened")]}
        rows={data.gates.map((gate) => ({
          key: gate.id,
          cells: [
            gate.kind,
            <ActivityBadge key={`${gate.id}-activity`} activity={gate.activity} reason={gate.activityReason} locale={locale} />,
            <StatusBadge key={gate.id} value={displayValueLabel(locale, gate.status)} tone={toneForStatus(gate.status)} />,
            <RawMessageDetails key={`${gate.id}-message`} message={gate.message} locale={locale} />,
            formatTime(gate.createdAt)
          ],
          cardTitle: gate.kind,
          cardMeta: `${formatTime(gate.createdAt)} / ${activityReasonLabel(locale, gate.activityReason)}`,
          cardSummary: summarizeRawMessage(gate.message, locale) ?? ""
        }))}
        empty={t(locale, "noGates")}
      />
    </div>
  );
}
