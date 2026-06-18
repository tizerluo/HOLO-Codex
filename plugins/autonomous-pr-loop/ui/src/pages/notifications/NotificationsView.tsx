import type { JSX } from "react";
import type { DashboardApi, LoopNotification } from "../../api.js";
import { Collapsible } from "../../components/Collapsible.js";
import { t } from "../../i18n.js";
import { NotificationList, severityLabel, type EffectiveLocale } from "../CommandCenterParts.js";

export function NotificationsView({ notifications, api, onRefresh, locale }: { notifications: LoopNotification[]; api: DashboardApi; onRefresh: () => void | Promise<void>; locale: EffectiveLocale }): JSX.Element {
  const groups = ["blocked", "confirmation_required", "attention", "informational"] as const;
  const markRead = async (): Promise<void> => {
    await api.mutate("/api/notifications/mark-read", { notificationIds: notifications.map((item) => item.id) });
    await Promise.resolve(onRefresh());
  };
  return (
    <div className="two-stack">
      <section className="focus-panel">
        <div>
          <p className="eyebrow">{t(locale, "needsAttention")}</p>
          <h2>{t(locale, "notificationsCount", { count: notifications.filter((item) => item.severity !== "informational").length })}</h2>
          <p>{t(locale, "quietProgress")}</p>
        </div>
        <button className="ghost-button" type="button" disabled={notifications.length === 0} onClick={() => void markRead()}>{t(locale, "actionMarkAllRead")}</button>
      </section>
      {groups.map((group) => (
        <Collapsible key={group} title={severityLabel(locale, group)} chip={t(locale, "metricItems", { count: notifications.filter((item) => item.severity === group).length })} defaultOpen={group !== "informational"}>
          <NotificationList items={notifications.filter((item) => item.severity === group)} locale={locale} />
        </Collapsible>
      ))}
    </div>
  );
}
