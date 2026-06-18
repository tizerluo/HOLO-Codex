import type { JSX } from "react";
import type { PlanNavigatorData, PrSelectionData } from "../../api.js";
import { Collapsible } from "../../components/Collapsible.js";
import { EmptyState } from "../../components/EmptyState.js";
import { List } from "../../components/List.js";
import { t } from "../../i18n.js";
import { PlanList, PlanSelectionSummary, type EffectiveLocale } from "../CommandCenterParts.js";

export function PlanNavigator({ data, selection, locale }: { data: PlanNavigatorData | undefined; selection: PrSelectionData | undefined; locale: EffectiveLocale }): JSX.Element {
  if (!data) return <EmptyState title={t(locale, "noPlanData")} message={t(locale, "noPlanDataMessage")} />;
  return (
    <div className="two-stack">
      <PlanSelectionSummary data={data} selection={selection} locale={locale} />
      <Collapsible title={t(locale, "completedPrs")} chip={t(locale, "completedChip", { count: data.completed.length })}><PlanList items={data.completed} locale={locale} /></Collapsible>
      <Collapsible title={t(locale, "candidatePrs")} chip={t(locale, "candidatesChip", { count: data.candidates.length })}><PlanList items={data.candidates} locale={locale} /></Collapsible>
      <Collapsible title={t(locale, "rawEvidence")} chip={t(locale, "sourcesChip", { count: data.evidence.length })}><List items={[data.convention, ...data.evidence]} locale={locale} /></Collapsible>
    </div>
  );
}
