import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { ConfigSnapshot, DashboardApi } from "../api.js";
import { displayValueLabel, localeOptionLabel, t } from "../i18n.js";
import { RiskBadge } from "./RiskBadge.js";
import { StatusBadge } from "./StatusBadge.js";
import { LOCALE_SETTINGS, type EffectiveLocale, type LocaleSetting } from "../../../core/locale.js";

interface ConfigEditorProps {
  snapshot: ConfigSnapshot;
  api: DashboardApi;
  onSaved: () => void;
  locale: EffectiveLocale;
}

const groups = [
  "Workflow",
  "Autonomy",
  "Language",
  "Merge",
  "Notifications",
  "Review Handling",
  "Safety Guards",
  "Dashboard",
  "Advanced Compatibility"
] as const;

const groupLabelKeys: Record<(typeof groups)[number], string> = {
  Workflow: "configGroupWorkflow",
  Autonomy: "configGroupAutonomy",
  Language: "configGroupLanguage",
  Merge: "configGroupMerge",
  Notifications: "configGroupNotifications",
  "Review Handling": "configGroupReview",
  "Safety Guards": "configGroupSafety",
  Dashboard: "configGroupDashboard",
  "Advanced Compatibility": "configGroupAdvanced"
};

const fieldLabelKeys: Record<string, string> = {
  loopShape: "fieldLoopShape",
  workflowProfile: "fieldWorkflowProfile",
  roleProfile: "fieldRoleProfile",
  autonomyMode: "fieldAutonomyMode",
  locale: "fieldConfigLocale",
  mergeMode: "fieldMergeMode",
  requireReviewApproval: "fieldRequireReviewApproval",
  notifyMode: "fieldNotifyMode",
  reviewHandling: "fieldReviewHandling",
  carryoverTarget: "fieldCarryoverTarget",
  gitnexusRequired: "fieldGitnexusRequired",
  requiredChecks: "fieldRequiredChecks",
  protectedPaths: "fieldProtectedPaths",
  maxReviewFixRounds: "fieldMaxReviewFixRounds",
  maxTestFixRounds: "fieldMaxTestFixRounds",
  maxCiReruns: "fieldMaxCiReruns",
  allowAutoMerge: "fieldAllowAutoMerge"
};

const PR_WORKFLOW_PROFILES = ["default_pr_loop", "docs_only_loop", "review_fix_loop", "release_ready_loop"];
const GENERIC_WORKFLOW_PROFILES = ["research_report_loop", "document_preparation_loop", "repo_hygiene_loop", "weekly_review_loop", "data_extraction_loop"];

export function ConfigEditor({ snapshot, api, onSaved, locale }: ConfigEditorProps): JSX.Element {
  const [expectedHash, setExpectedHash] = useState(snapshot.hash);
  const [baselineConfig, setBaselineConfig] = useState<Record<string, unknown>>(snapshot.config);
  const [config, setConfig] = useState<Record<string, unknown>>(snapshot.config);
  const [note, setNote] = useState("");
  const [confirmationToken, setConfirmationToken] = useState("");
  const [message, setMessage] = useState("");
  const diff = useMemo(() => changedFields(baselineConfig, config), [baselineConfig, config]);
  const highRisk = diff.some((field) => ["mergeMode", "requireReviewApproval", "gitnexusRequired", "protectedPaths", "reviewHandling"].includes(field));
  const dangerous = hasDangerousChange(baselineConfig, config);
  const save = async (): Promise<void> => {
    const result = await api.mutate("/api/policy-config", {
      expectedHash,
      nextConfig: config,
      note,
      confirmationToken
    });
    if (result.ok) {
      const saved = isRecord(result.data) ? result.data : {};
      const savedConfig = isRecord(saved.config) ? saved.config : config;
      const savedSnapshot = isRecord(saved.snapshot) ? saved.snapshot : undefined;
      setMessage(t(locale, "configSaved"));
      setConfig(savedConfig);
      setBaselineConfig(savedConfig);
      if (savedSnapshot && typeof savedSnapshot.hash === "string") {
        setExpectedHash(savedSnapshot.hash);
      }
      setConfirmationToken("");
      onSaved();
    } else {
      setMessage(result.error?.message ?? t(locale, "configSaveFailed"));
    }
  };

  return (
    <div className="config-editor">
      <div className="forecast-strip">
        <Summary label={t(locale, "configGroupWorkflow")} value={displayValueLabel(locale, String(config.workflowProfile ?? "default_pr_loop"))} />
        <Summary label={t(locale, "configGroupAutonomy")} value={displayValueLabel(locale, String(config.autonomyMode ?? "autonomous_until_gate"))} />
        <Summary label={t(locale, "configGroupMerge")} value={displayValueLabel(locale, String(config.mergeMode ?? "manual"))} />
        <Summary label={t(locale, "configGroupNotifications")} value={displayValueLabel(locale, String(config.notifyMode ?? "important_only"))} />
      </div>

      {groups.map((group) => (
        <details className="disclosure-panel" key={group}>
          <summary>
            <span>{t(locale, groupLabelKeys[group])}</span>
            <StatusBadge value={summaryFor(group, config, locale)} tone={group === "Merge" && config.mergeMode === "conditional" ? "yellow" : "blue"} />
          </summary>
          <ConfigGroup group={group} config={config} setConfig={setConfig} locale={locale} />
        </details>
      ))}

      <section className="config-save-panel">
        <div className="section-heading compact">
          <div>
            <h2>{t(locale, "configDiffTitle")}</h2>
            <p>{diff.length === 0 ? t(locale, "configNoChanges") : t(locale, "configChangedFields", { count: diff.length })}</p>
          </div>
          <RiskBadge risk={highRisk ? "high" : diff.length > 0 ? "medium" : "low"} locale={locale} />
        </div>
        <div className="diff-list">
          {diff.length === 0 ? <span className="muted-copy">{t(locale, "configChangeControl")}</span> : diff.map((field) => (
            <code key={field}>{field}: {JSON.stringify(baselineConfig[field])} {"->"} {JSON.stringify(config[field])}</code>
          ))}
        </div>
        {dangerous ? <p className="warning-copy">{t(locale, "configDangerous")}</p> : null}
        <label>
          {t(locale, "operatorNote")}
          <textarea
            aria-label={t(locale, "policyChangeNote")}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t(locale, "operatorNotePlaceholder")}
          />
        </label>
        <label>
          {t(locale, "confirmationToken")}
          <input
            aria-label={t(locale, "confirmationToken")}
            value={confirmationToken}
            onChange={(event) => setConfirmationToken(event.target.value)}
            placeholder={t(locale, "confirmationTokenPlaceholder")}
          />
        </label>
        <div className="button-row">
          <button className="success-button" type="button" disabled={diff.length === 0 || (dangerous && confirmationToken.trim() !== "CONFIRM")} onClick={() => void save()}>
            {t(locale, "actionSaveConfig")}
          </button>
          <button className="ghost-button" type="button" onClick={() => setConfig(baselineConfig)}>
            {t(locale, "actionRevert")}
          </button>
        </div>
        {message ? <p className="action-message">{message}</p> : null}
      </section>
    </div>
  );
}

function ConfigGroup({
  group,
  config,
  setConfig,
  locale,
}: {
  group: (typeof groups)[number];
  config: Record<string, unknown>;
  setConfig: (config: Record<string, unknown>) => void;
  locale: EffectiveLocale;
}): JSX.Element {
  if (group === "Workflow") {
    const loopShape = String(config.loopShape ?? "pr-loop");
    const workflowOptions = loopShape === "generic-loop" ? GENERIC_WORKFLOW_PROFILES : PR_WORKFLOW_PROFILES;
    return (
      <div className="form-grid">
        <SelectField field="loopShape" options={["pr-loop", "generic-loop"]} config={config} setConfig={(next) => {
          const nextShape = String(next.loopShape ?? "pr-loop");
          setConfig({
            ...next,
            workflowProfile: nextShape === "generic-loop" ? "research_report_loop" : "default_pr_loop"
          });
        }} locale={locale} />
        <SelectField field="workflowProfile" options={workflowOptions} config={config} setConfig={setConfig} locale={locale} />
        <SelectField field="roleProfile" options={["default_pr_roles"]} config={config} setConfig={setConfig} locale={locale} />
      </div>
    );
  }
  if (group === "Autonomy") {
    return <SelectField field="autonomyMode" options={["supervised", "autonomous_until_gate", "autonomous_until_terminal"]} config={config} setConfig={setConfig} locale={locale} />;
  }
  if (group === "Language") {
    return <SelectField field="locale" options={[...LOCALE_SETTINGS]} config={config} setConfig={setConfig} locale={locale} />;
  }
  if (group === "Merge") {
    return (
      <div className="form-grid merge-config-grid">
        <SelectField field="mergeMode" options={["manual", "conditional", "disabled"]} config={config} setConfig={setConfig} locale={locale} />
        <ToggleField field="requireReviewApproval" config={config} setConfig={setConfig} locale={locale} />
      </div>
    );
  }
  if (group === "Notifications") {
    return <SelectField field="notifyMode" options={["all_gates", "important_only", "blockers_only"]} config={config} setConfig={setConfig} locale={locale} />;
  }
  if (group === "Review Handling") {
    return (
      <div className="form-grid">
        <SelectField field="reviewHandling" options={["fix_scoped_and_carry_forward", "ask_on_any_review", "require_zero_open_findings"]} config={config} setConfig={setConfig} locale={locale} />
        <TextField field="carryoverTarget" config={config} setConfig={setConfig} locale={locale} />
      </div>
    );
  }
  if (group === "Safety Guards") {
    return (
      <div className="form-grid">
        <ToggleField field="gitnexusRequired" config={config} setConfig={setConfig} locale={locale} />
        <ArrayField field="requiredChecks" config={config} setConfig={setConfig} locale={locale} />
        <ArrayField field="protectedPaths" config={config} setConfig={setConfig} locale={locale} />
        <NumberField field="maxReviewFixRounds" config={config} setConfig={setConfig} locale={locale} />
        <NumberField field="maxTestFixRounds" config={config} setConfig={setConfig} locale={locale} />
        <NumberField field="maxCiReruns" config={config} setConfig={setConfig} locale={locale} />
      </div>
    );
  }
  if (group === "Dashboard") {
    const dashboard = (config.dashboard as Record<string, unknown> | undefined) ?? { enabled: true, host: "127.0.0.1" };
    return (
      <div className="form-grid">
        <label>
          {t(locale, "dashboardHost")}
          <input
            aria-label={t(locale, "dashboardHost")}
            value={String(dashboard.host ?? "127.0.0.1")}
            onChange={(event) => setConfig({ ...config, dashboard: { ...dashboard, host: event.target.value } })}
          />
        </label>
        <label>
          {t(locale, "dashboardPort")}
          <input
            aria-label={t(locale, "dashboardPort")}
            type="number"
            value={String(dashboard.port ?? "")}
            onChange={(event) => setConfig({ ...config, dashboard: { ...dashboard, port: event.target.value ? Number(event.target.value) : undefined } })}
          />
        </label>
      </div>
    );
  }
  return (
    <div className="form-grid">
      <ToggleField field="allowAutoMerge" config={config} setConfig={setConfig} locale={locale} disabled />
      <p className="muted-copy">{t(locale, "compatibilityView")}</p>
    </div>
  );
}

function SelectField({
  field,
  options,
  config,
  setConfig,
  locale,
}: {
  field: string;
  options: string[];
  config: Record<string, unknown>;
  setConfig: (config: Record<string, unknown>) => void;
  locale: EffectiveLocale;
}): JSX.Element {
  const label = fieldLabel(locale, field);
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={String(config[field] ?? options[0])}
        onChange={(event) => {
          setConfig({ ...config, [field]: event.target.value });
        }}
      >
        {options.map((option) => <option key={option} value={option}>{optionLabel(locale, field, option)}</option>)}
      </select>
    </label>
  );
}

function ToggleField({
  field,
  config,
  setConfig,
  locale,
  disabled
}: {
  field: string;
  config: Record<string, unknown>;
  setConfig: (config: Record<string, unknown>) => void;
  locale: EffectiveLocale;
  disabled?: boolean;
}): JSX.Element {
  const label = fieldLabel(locale, field);
  return (
    <label className="toggle-row">
      <input
        aria-label={label}
        type="checkbox"
        checked={Boolean(config[field])}
        disabled={disabled}
        onChange={(event) => setConfig({ ...config, [field]: event.target.checked })}
      />
      {label}
    </label>
  );
}

function TextField({ field, config, setConfig, locale }: { field: string; config: Record<string, unknown>; setConfig: (config: Record<string, unknown>) => void; locale: EffectiveLocale }): JSX.Element {
  const label = fieldLabel(locale, field);
  return (
    <label>
      {label}
      <input aria-label={label} value={String(config[field] ?? "")} onChange={(event) => setConfig({ ...config, [field]: event.target.value })} />
    </label>
  );
}

function NumberField({ field, config, setConfig, locale }: { field: string; config: Record<string, unknown>; setConfig: (config: Record<string, unknown>) => void; locale: EffectiveLocale }): JSX.Element {
  const label = fieldLabel(locale, field);
  return (
    <label>
      {label}
      <input aria-label={label} type="number" min="0" value={Number(config[field] ?? 0)} onChange={(event) => setConfig({ ...config, [field]: Number(event.target.value) })} />
    </label>
  );
}

function ArrayField({ field, config, setConfig, locale }: { field: string; config: Record<string, unknown>; setConfig: (config: Record<string, unknown>) => void; locale: EffectiveLocale }): JSX.Element {
  const label = fieldLabel(locale, field);
  return (
    <label>
      {label}
      <input
        aria-label={label}
        value={Array.isArray(config[field]) ? (config[field] as string[]).join(", ") : ""}
        onChange={(event) => setConfig({ ...config, [field]: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })}
      />
    </label>
  );
}

function Summary({ label, value }: { label: string; value: string }): JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys({ ...before, ...after }).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

function hasDangerousChange(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return (before.mergeMode !== after.mergeMode && after.mergeMode === "conditional") ||
    (before.requireReviewApproval !== after.requireReviewApproval && after.requireReviewApproval === false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldLabel(locale: EffectiveLocale, field: string): string {
  return t(locale, fieldLabelKeys[field] ?? field);
}

function summaryFor(group: string, config: Record<string, unknown>, locale: EffectiveLocale): string {
  if (group === "Workflow") return displayValueLabel(locale, String(config.workflowProfile ?? "default_pr_loop"));
  if (group === "Autonomy") return displayValueLabel(locale, String(config.autonomyMode ?? t(locale, "summaryDefault")));
  if (group === "Language") return localeOptionLabel(locale, (config.locale ?? "zh-CN") as LocaleSetting);
  if (group === "Merge") return displayValueLabel(locale, String(config.mergeMode ?? "manual"));
  if (group === "Notifications") return displayValueLabel(locale, String(config.notifyMode ?? "important_only"));
  if (group === "Review Handling") return displayValueLabel(locale, String(config.reviewHandling ?? t(locale, "summaryDefault")));
  if (group === "Safety Guards") return Boolean(config.gitnexusRequired) ? t(locale, "summaryGuarded") : t(locale, "summaryRelaxed");
  if (group === "Dashboard") return t(locale, "summaryLocal");
  return t(locale, "summaryDerived");
}

function optionLabel(locale: EffectiveLocale, field: string, option: string): string {
  if (field === "locale") {
    return localeOptionLabel(locale, option as LocaleSetting);
  }
  return displayValueLabel(locale, option);
}
