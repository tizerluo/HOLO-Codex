export const THEME_SETTINGS = ["light", "dark", "system"] as const;
export type ThemeSetting = typeof THEME_SETTINGS[number];
export type EffectiveTheme = "light" | "dark";

export const DEFAULT_THEME_SETTING: ThemeSetting = "system";
export const DASHBOARD_THEME_STORAGE_KEY = "agent-loop-dashboard-theme";

/** Normalize an unknown value into a supported dashboard theme setting. */
export function normalizeThemeSetting(value: unknown): ThemeSetting | undefined {
  return THEME_SETTINGS.includes(value as ThemeSetting) ? value as ThemeSetting : undefined;
}

/** Read the persisted local dashboard theme preference. */
export function readStoredThemeSetting(): ThemeSetting | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const storage = window.localStorage;
  if (typeof storage?.getItem !== "function") {
    return undefined;
  }
  return normalizeThemeSetting(storage.getItem(DASHBOARD_THEME_STORAGE_KEY));
}

/** Persist the local dashboard theme preference. */
export function writeStoredThemeSetting(theme: ThemeSetting): void {
  if (typeof window !== "undefined" && typeof window.localStorage?.setItem === "function") {
    window.localStorage.setItem(DASHBOARD_THEME_STORAGE_KEY, theme);
  }
}

/** Resolve a user theme setting into the effective light or dark theme. */
export function resolveEffectiveTheme(
  setting: ThemeSetting | undefined,
  prefersDark = browserPrefersDark()
): EffectiveTheme {
  const normalized = setting ?? DEFAULT_THEME_SETTING;
  if (normalized === "light" || normalized === "dark") {
    return normalized;
  }
  return prefersDark ? "dark" : "light";
}

/** Apply the effective dashboard theme to the document root. */
export function applyDashboardTheme(theme: EffectiveTheme): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
  }
}

/** Return the browser dark-mode preference, defaulting to dark when unavailable. */
export function browserPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
