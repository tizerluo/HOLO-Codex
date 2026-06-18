import type { JSX } from "react";
import type { MissionControlData } from "../../api.js";
import { ResponsiveTable } from "../../components/ResponsiveTable.js";
import { t } from "../../i18n.js";
import type { EffectiveLocale } from "../CommandCenterParts.js";

export function ScopeGuard({ data, locale }: { data: MissionControlData; locale: EffectiveLocale }): JSX.Element {
  const scopeEvents = data.events.filter((event) => event.kind.includes("scope") || event.kind.includes("gitnexus") || event.kind.includes("policy"));
  return (
    <ResponsiveTable
      columns={[t(locale, "tableSeq"), t(locale, "tableEvent"), t(locale, "tableMessage"), t(locale, "tableState")]}
      rows={scopeEvents.map((event) => ({ key: event.id, cells: [String(event.seq), event.kind, event.message, event.stateAfter ?? "-"], cardTitle: event.kind, cardMeta: `#${event.seq}`, cardSummary: event.message }))}
      empty={t(locale, "noScopeEvidence")}
    />
  );
}
