/** Locale settings accepted by config, CLI, and dashboard controls. */
export const LOCALE_SETTINGS = ["zh-CN", "en-US", "system"] as const;

/** Concrete locales with available display dictionaries. */
export const EFFECTIVE_LOCALES = ["zh-CN", "en-US"] as const;

/** Default locale for repository config and display fallback. */
export const DEFAULT_LOCALE: EffectiveLocale = "zh-CN";

/** Persisted locale preference accepted by repo config and UI controls. */
export type LocaleSetting = (typeof LOCALE_SETTINGS)[number];

/** Concrete locale used for selecting display copy. */
export type EffectiveLocale = (typeof EFFECTIVE_LOCALES)[number];

/** Return true when a value is a supported persisted locale setting. */
export function isLocaleSetting(value: unknown): value is LocaleSetting {
  return typeof value === "string" && LOCALE_SETTINGS.includes(value as LocaleSetting);
}

/** Normalize unknown input to a locale setting, or undefined when unsupported. */
export function normalizeLocaleSetting(value: unknown): LocaleSetting | undefined {
  return isLocaleSetting(value) ? value : undefined;
}

/** Resolve persisted/system locale settings to a concrete display locale. */
export function resolveEffectiveLocale(
  setting: LocaleSetting | undefined,
  systemLocales: readonly string[] = []
): EffectiveLocale {
  if (setting === "zh-CN" || setting === "en-US") {
    return setting;
  }
  return resolveSystemLocale(systemLocales);
}

/** Map browser or process locale tags to supported display locales. */
export function resolveSystemLocale(systemLocales: readonly string[] = []): EffectiveLocale {
  for (const locale of systemLocales) {
    const normalized = locale.toLowerCase();
    if (normalized === "zh-cn" || normalized.startsWith("zh")) {
      return "zh-CN";
    }
    if (normalized === "en-us" || normalized.startsWith("en")) {
      return "en-US";
    }
  }
  return DEFAULT_LOCALE;
}

/** Return Node's process/system locale candidates for CLI resolution. */
export function processLocaleCandidates(): string[] {
  const candidates = [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale
  ];
  return candidates.filter((value): value is string => typeof value === "string" && value.length > 0);
}
