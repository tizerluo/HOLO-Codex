import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { ConfigSnapshot, DashboardApi } from "../../api.js";
import { ConfigEditor } from "../../components/ConfigEditor.js";
import { EmptyState } from "../../components/EmptyState.js";
import { ErrorState } from "../../components/ErrorState.js";
import { t } from "../../i18n.js";
import type { EffectiveLocale } from "../CommandCenterParts.js";

export function PolicyConfig({ api, onRefresh, locale }: { api: DashboardApi; onRefresh: () => void; locale: EffectiveLocale }): JSX.Element {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void api.policyConfig().then((result) => {
      if (result.ok && result.data) setSnapshot(result.data);
      else setError(result.error?.message ?? t(locale, "policyConfigLoadError"));
    });
  }, [api, locale]);
  if (error) return <ErrorState title={t(locale, "policyConfigUnavailable")} message={error} />;
  if (!snapshot) return <EmptyState title={t(locale, "loadingConfig")} message={t(locale, "loadingConfigMessage")} />;
  return <ConfigEditor snapshot={snapshot} api={api} onSaved={onRefresh} locale={locale} />;
}
