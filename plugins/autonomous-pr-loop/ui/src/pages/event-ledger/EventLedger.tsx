import type { JSX } from "react";
import type { EventSummary } from "../../api.js";
import { ResponsiveTable } from "../../components/ResponsiveTable.js";
import { t } from "../../i18n.js";
import { formatTime, type EffectiveLocale } from "../CommandCenterParts.js";

export function EventLedger({ events, locale }: { events: EventSummary[]; locale: EffectiveLocale }): JSX.Element {
  return (
    <div className="event-ledger-table">
      <ResponsiveTable
        columns={[t(locale, "tableSeq"), t(locale, "tableTime"), t(locale, "tableEvent"), t(locale, "tableDetails")]}
        rows={events.map((event) => ({ key: event.id, cells: [String(event.seq), formatTime(event.createdAt), event.kind, event.message], cardTitle: event.kind, cardMeta: `${formatTime(event.createdAt)} / #${event.seq}`, cardSummary: event.message }))}
        empty={t(locale, "noEvents")}
      />
    </div>
  );
}
