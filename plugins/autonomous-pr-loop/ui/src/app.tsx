import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { createDashboardApi, storeDashboardToken, storedDashboardToken, type DashboardApi, type DashboardMetaData, type MissionControlData } from "./api.js";
import { BrandMark } from "./components/BrandMark.js";
import { createFixtureDashboardApi, dashboardFixture } from "./fixtures.js";
import {
  readStoredLocaleSetting,
  resolveDashboardLocale,
  t,
  writeStoredLocaleSetting
} from "./i18n.js";
import { CommandCenter } from "./pages/CommandCenter.js";
import {
  applyDashboardTheme,
  DEFAULT_THEME_SETTING,
  readStoredThemeSetting,
  resolveEffectiveTheme,
  writeStoredThemeSetting,
  type ThemeSetting
} from "./theme.js";
import { normalizeLocaleSetting, type LocaleSetting } from "../../core/locale.js";
import "./styles.css";

export interface AppProps {
  api?: DashboardApi;
  initialData?: MissionControlData;
}

export function App({ api, initialData }: AppProps): JSX.Element {
  const fixtureData = useMemo(() => dashboardFixture(fixtureNameFromLocation()), []);
  const requiresToken = !api && !fixtureData && !initialData;
  const [dashboardToken, setDashboardToken] = useState(() => requiresToken ? storedDashboardToken() : "");
  const client = useMemo(
    () => api ?? (fixtureData ? createFixtureDashboardApi(fixtureData) : createDashboardApi(dashboardToken)),
    [api, dashboardToken, fixtureData]
  );
  const [data, setData] = useState<MissionControlData | undefined>(initialData ?? fixtureData);
  const [meta, setMeta] = useState<DashboardMetaData>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(!initialData && !fixtureData);
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const [actionMessage, setActionMessage] = useState<string>();
  const [localeSetting, setLocaleSetting] = useState<LocaleSetting>(() => readStoredLocaleSetting() ?? "system");
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>(() => readStoredThemeSetting() ?? DEFAULT_THEME_SETTING);
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [repoLocale, setRepoLocale] = useState<LocaleSetting>();
  const pollDelayRef = useRef(3000);
  const effectiveLocale = resolveDashboardLocale(localeSetting, repoLocale);
  const effectiveTheme = resolveEffectiveTheme(themeSetting, systemPrefersDark);
  const authenticated = !requiresToken || dashboardToken.length > 0;

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const result = await client.missionControl();
    if (result.ok && result.data) {
      setData(result.data);
      setError(undefined);
      setLastRefresh(Date.now());
      setActionMessage(t(effectiveLocale, "appUpdated"));
      pollDelayRef.current = 3000;
    } else {
      setError(result.error?.message ?? t(effectiveLocale, "appUnknownError"));
      pollDelayRef.current = Math.min(pollDelayRef.current * 2, 30000);
    }
    setLoading(false);
  }, [client, effectiveLocale]);

  useEffect(() => {
    applyDashboardTheme(effectiveTheme);
  }, [effectiveTheme]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => setSystemPrefersDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let active = true;
    void client.dashboardMeta().then((result) => {
      if (active && result.ok && result.data) {
        setMeta(result.data);
      }
    });
    void client.policyConfig().then((result) => {
      if (!active || !result.ok || !result.data) {
        return;
      }
      setRepoLocale(normalizeLocaleSetting(result.data.config.locale));
    });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      await refresh();
      if (active) {
        timer = window.setTimeout(() => {
          void poll();
        }, pollDelayRef.current);
      }
    };
    if (!authenticated) {
      setLoading(false);
    } else if (!initialData && !fixtureData) {
      void poll();
    } else {
      timer = window.setTimeout(() => {
        void poll();
      }, pollDelayRef.current);
    }
    return () => {
      active = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [authenticated, fixtureData, initialData, refresh]);

  if (!authenticated) {
    return (
      <LoginScreen
        locale={effectiveLocale}
        onLogin={(token) => {
          storeDashboardToken(token);
          setDashboardToken(token);
        }}
      />
    );
  }

  if (loading && !data) {
    return (
      <div className="state-screen">
        <Loader2 className="spin" size={30} />
        <h1>{t(effectiveLocale, "appLoadingTitle")}</h1>
        <p>{t(effectiveLocale, "appLoadingMessage")}</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="state-screen state-screen--error">
        <AlertTriangle size={30} />
        <h1>{t(effectiveLocale, "appUnavailableTitle")}</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="state-screen">
        <h1>{t(effectiveLocale, "appNoDataTitle")}</h1>
        <p>{t(effectiveLocale, "appNoDataMessage")}</p>
      </div>
    );
  }

  const commandCenterProps = {
    data,
    meta,
    api: client,
    stale: Date.now() - lastRefresh > 7000,
    onRefresh: () => void refresh(),
    locale: effectiveLocale,
    localeSetting,
    onLocaleSettingChange: (next: LocaleSetting) => {
      writeStoredLocaleSetting(next);
      setLocaleSetting(next);
    },
    themeSetting,
    effectiveTheme,
    onThemeSettingChange: (next: ThemeSetting) => {
      writeStoredThemeSetting(next);
      setThemeSetting(next);
    },
    ...(error ?? actionMessage ? { actionMessage: error ?? actionMessage } : {})
  };

  return (
    <CommandCenter
      {...commandCenterProps}
    />
  );
}

function LoginScreen({ locale, onLogin }: { locale: ReturnType<typeof resolveDashboardLocale>; onLogin: (token: string) => void }): JSX.Element {
  const [value, setValue] = useState("");
  return (
    <div className="state-screen login-screen">
      <div className="login-brand">
        <BrandMark className="brand-logo brand-logo--login" />
        <strong>HOLO-Codex</strong>
      </div>
      <h1>{t(locale, "loginTitle")}</h1>
      <p>{t(locale, "loginMessage")}</p>
      <form
        className="login-form"
        onSubmit={(event) => {
          event.preventDefault();
          const token = value.trim();
          if (token) onLogin(token);
        }}
      >
        <input
          aria-label={t(locale, "loginTokenLabel")}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t(locale, "loginTokenPlaceholder")}
          type="password"
        />
        <button className="success-button" type="submit" disabled={value.trim().length === 0}>{t(locale, "loginSubmit")}</button>
      </form>
    </div>
  );
}

function fixtureNameFromLocation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URL(window.location.href).searchParams.get("fixture") ?? undefined;
}
