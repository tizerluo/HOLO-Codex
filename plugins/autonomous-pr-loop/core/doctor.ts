import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactRemote, runCommand } from "./command.js";
import { loadConfig, statePath } from "./config.js";
import { AgentLoopError } from "./errors.js";
import { inspectHookCapture } from "./hook-capture.js";
import { agentLoopRouterHookCommand, collectHookCommands, isLegacyAgentLoopHookCommand } from "./hook-installation.js";
import { CODEX_HOOK_EVENTS, hookScriptName } from "./hook-events.js";
import { hookRegistryPath, inspectHookRegistryLock, listHookBindings } from "./hook-router.js";
import { defaultPackageRoot, hookDistRoot, hookSourceRoot } from "./plugin-paths.js";
import { SqliteAgentLoopStorage } from "./storage.js";
import type { AgentTimelineIntegrityReport, DoctorCheck, DoctorReport } from "./types.js";

/** Run PR A environment diagnostics for the current repository. */
export function runDoctor(repoRoot: string): DoctorReport {
  const checks: DoctorCheck[] = [];
  const gitRoot = runCommand("git", ["rev-parse", "--show-toplevel"], repoRoot);
  pushCheck(checks, "git repo", gitRoot.ok, "Current directory is inside a git repository.");

  const remote = runCommand("git", ["remote", "get-url", "origin"], repoRoot);
  const githubRemote = remote.ok && remote.stdout.includes("github.com");
  pushCheck(checks, "github remote", githubRemote, "origin remote points to GitHub.", {
    remote: remote.ok ? redactRemote(remote.stdout) : redactRemote(remote.stderr)
  });

  const ghAuth = runCommand("gh", ["auth", "status", "-h", "github.com"], repoRoot);
  const ghAuthed = ghAuth.ok;
  pushCheck(checks, "gh auth", ghAuthed, "GitHub CLI is authenticated.");
  if (ghAuth.ok) {
    const hasRepo = ghAuth.combined.includes("'repo'") || ghAuth.combined.includes(" repo");
    const hasWorkflow =
      ghAuth.combined.includes("'workflow'") || ghAuth.combined.includes(" workflow");
    checks.push({
      name: "gh token scopes",
      status: hasRepo ? (hasWorkflow ? "pass" : "warn") : "fail",
      message: hasRepo
        ? hasWorkflow
          ? "gh token has repo and workflow scopes."
          : "gh token has repo scope; workflow scope is recommended."
        : "gh token must include repo scope."
    });
  }

  const codex = runCommand("codex", ["--version"], repoRoot);
  pushCheck(checks, "codex cli", codex.ok, "codex CLI is available.", {
    version: codex.ok ? codex.stdout : codex.stderr
  });

  const packageRoot = defaultPackageRoot();
  checks.push(checkHooksBuilt(packageRoot, repoRoot));
  checks.push(checkHooksInstalled(repoRoot, packageRoot));

  const nodeMajorMinor = process.versions.node.split(".").slice(0, 2).map(Number);
  const nodeOk =
    (nodeMajorMinor[0] ?? 0) > 22 ||
    ((nodeMajorMinor[0] ?? 0) === 22 && (nodeMajorMinor[1] ?? 0) >= 5);
  pushCheck(checks, "node version", nodeOk, "Node version supports node:sqlite.", {
    version: process.version
  });

  let missingConfig = false;
  try {
    const { config } = loadConfig(repoRoot);
    checks.push({
      name: "config schema",
      status: "pass",
      message: ".agent-loop/config.json is valid."
    });
    checks.push({
      name: "plansDir",
      status: existsSync(join(repoRoot, config.plansDir)) ? "pass" : "fail",
      message: `plansDir exists: ${config.plansDir}`
    });

    const storage = new SqliteAgentLoopStorage(statePath(repoRoot));
    let timelineIntegrity: AgentTimelineIntegrityReport;
    try {
      storage.writeRepoConfig(config);
      try {
        timelineIntegrity = storage.checkTimelineIntegrity();
      } catch (error) {
        timelineIntegrity = failedTimelineIntegrity(error);
      }
    } finally {
      storage.close();
    }
    checks.push({
      name: "storage",
      status: "pass",
      message: "Storage can be opened and written."
    });
    checks.push({
      name: "timeline integrity",
      status: timelineIntegrity.ok ? "pass" : "fail",
      message: timelineIntegrity.ok
        ? "Timeline index and triggers are installed."
        : "Timeline index or triggers are missing.",
      details: timelineIntegrity
    });

    const gitnexus = runCommand("npx", ["gitnexus", "--version"], repoRoot);
    checks.push({
      name: "gitnexus",
      status: gitnexus.ok ? "pass" : config.gitnexusRequired ? "fail" : "warn",
      message: gitnexus.ok
        ? "GitNexus is available."
        : "GitNexus is not available from npx gitnexus --version."
    });
  } catch (error) {
    if (error instanceof AgentLoopError && error.code === "needs_repo_init") {
      missingConfig = true;
      checks.push({
        name: "config schema",
        status: "fail",
        message: "Missing .agent-loop/config.json.",
        details: { gate: "needs_repo_init" }
      });
    } else {
      checks.push({
        name: "config schema",
        status: "fail",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const status = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";
  return {
    status,
    checks,
    ...(missingConfig ? { gate: "needs_repo_init" } : {})
  };
}

function checkHooksBuilt(packageRoot: string, targetRepoRoot: string): DoctorCheck {
  const sourceDir = hookSourceRoot(packageRoot);
  const distDir = hookDistRoot(packageRoot);
  const installCommand = installHooksCommand(targetRepoRoot);
  const missing = CODEX_HOOK_EVENTS
    .map((event) => hookScriptName(event))
    .filter((script) => !existsSync(join(distDir, script)));
  if (missing.length > 0) {
    return {
      name: "codex hooks build",
      status: "warn",
      message: `Compiled hook runners are missing. Run \`pnpm build:hooks\` from ${packageRoot}, then \`${installCommand}\`.`,
      details: { packageRoot, distDir, missing, installCommand }
    };
  }
  const stale = CODEX_HOOK_EVENTS
    .map((event) => ({
      source: join(sourceDir, hookScriptName(event).replace(/\.js$/, ".ts")),
      dist: join(distDir, hookScriptName(event))
    }))
    .filter((entry) => existsSync(entry.source) && statSync(entry.dist).mtimeMs < statSync(entry.source).mtimeMs);
  return {
    name: "codex hooks build",
    status: stale.length === 0 ? "pass" : "warn",
    message: stale.length === 0
      ? "Compiled hook runners are available."
      : `Compiled hook runners are older than sources. Run \`pnpm build:hooks\` from ${packageRoot}, then \`${installCommand}\`.`,
    ...(stale.length > 0 ? { details: { packageRoot, stale, installCommand } } : {})
  };
}

function checkHooksInstalled(repoRoot: string, pluginRoot: string): DoctorCheck {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const hooksPath = join(codexHome, "hooks.json");
  const installCommand = installHooksCommand(repoRoot);
  if (!existsSync(hooksPath)) {
    return {
      name: "codex hooks",
      status: "warn",
      message: `Codex hooks are not installed. Run \`${installCommand}\`.`,
      details: { hooksPath, targetRepoRoot: repoRoot, pluginRoot, installCommand }
    };
  }
  const text = readFileSync(hooksPath, "utf8");
  let parsedHooks: unknown;
  try {
    parsedHooks = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      name: "codex hooks",
      status: "warn",
      message: `Codex hooks config is not valid JSON. Fix ${hooksPath}, then run \`${installCommand}\`.`,
      details: { hooksPath, error: error instanceof Error ? error.message : String(error), installCommand }
    };
  }
  const commands = collectHookCommands(parsedHooks);
  const missing = CODEX_HOOK_EVENTS.filter((event) => !commands.includes(agentLoopRouterHookCommand(event, pluginRoot)));
  const legacyCommands = commands.filter(isLegacyAgentLoopHookCommand);
  const expectedDist = hookDistRoot(pluginRoot);
  const routerCommands = commands.filter((command) => command.includes("autonomous-pr-loop/hooks/dist/"));
  const unexpectedRouterCommands = routerCommands.filter((command) => !command.includes(expectedDist));
  let bindings: ReturnType<typeof listHookBindings>;
  let registryError: string | undefined;
  try {
    bindings = listHookBindings(codexHome);
  } catch (error) {
    bindings = [];
    registryError = error instanceof Error ? error.message : String(error);
  }
  const activeBindings = bindings.filter((binding) => binding.status === "active");
  const currentRepoBindings = activeBindings.filter((binding) => binding.repoRoot === repoRoot);
  const lock = inspectHookRegistryLock(codexHome);
  const capture = inspectHookCapture(repoRoot, codexHome);
  const installed = missing.length === 0;
  const routerDistDrift = unexpectedRouterCommands.length > 0;
  const captureWarn = capture.status === "ambiguous" || capture.status === "unavailable";
  const status = !installed ? "warn" : routerDistDrift || registryError || lock.stale || legacyCommands.length > 0 || currentRepoBindings.length === 0 || captureWarn ? "warn" : "pass";
  const message = hookInstallMessage({
    installed,
    routerDistDrift,
    registryError,
    lockStale: lock.stale,
    lockPath: lock.path,
    legacyCommands,
    currentRepoBindings,
    installCommand,
    codexHome
  });
  return {
    name: "codex hooks",
    status,
    message,
    details: {
      hooksPath,
      registryPath: hookRegistryPath(codexHome),
      targetRepoRoot: repoRoot,
      pluginRoot,
      expectedDist,
      missing,
      legacyCommands,
      routerCommandsPointToExpectedDist: routerCommands.length > 0 && unexpectedRouterCommands.length === 0,
      unexpectedRouterCommands,
      activeBindings: activeBindings.length,
      currentRepoBindings: currentRepoBindings.length,
      lock,
      hookCapture: capture,
      ...(registryError ? { registryError } : {}),
      installCommand
    }
  };
}

function hookInstallMessage(input: {
  installed: boolean;
  routerDistDrift: boolean;
  registryError: string | undefined;
  lockStale: boolean;
  lockPath: string;
  legacyCommands: string[];
  currentRepoBindings: unknown[];
  installCommand: string;
  codexHome: string;
}): string {
  if (!input.installed && input.routerDistDrift) {
    return `Codex hook router is not installed at the expected hook dist; existing router commands point outside the expected hook dist. Run \`${input.installCommand}\` to refresh router hooks and bind this repo.`;
  }
  if (!input.installed) {
    return `Codex hook router is not installed. Run \`${input.installCommand}\` to install router hooks and bind this repo.`;
  }
  if (input.routerDistDrift) {
    return `Codex hook router includes commands outside the expected hook dist. Run \`${input.installCommand}\` to refresh router hooks.`;
  }
  if (input.registryError) {
    return `Codex hook binding registry is not valid. Fix ${hookRegistryPath(input.codexHome)}, then run \`${input.installCommand}\`.`;
  }
  if (input.lockStale) {
    return `Codex hook binding registry lock appears stale. Remove ${input.lockPath} or rerun after the stale writer exits.`;
  }
  if (input.legacyCommands.length > 0) {
    return `Codex hook router is installed, but legacy per-repo agent-loop hooks remain. Run \`${input.installCommand}\` to migrate them.`;
  }
  if (input.currentRepoBindings.length === 0) {
    return `Codex hook router is installed, but this repo is not bound. Run \`${input.installCommand}\`.`;
  }
  return "HOLO-Codex hook router is installed and this repo has an active binding.";
}

function installHooksCommand(repoRoot: string): string {
  return `agent-loop install-hooks --repo ${shellQuote(repoRoot)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function pushCheck(
  checks: DoctorCheck[],
  name: string,
  pass: boolean,
  message: string,
  details?: unknown
): void {
  checks.push({
    name,
    status: pass ? "pass" : "fail",
    message: pass ? message : `${message} Check failed.`,
    ...(details ? { details } : {})
  });
}

function failedTimelineIntegrity(error: unknown): AgentTimelineIntegrityReport {
  return {
    ok: false,
    missingTable: false,
    missingTriggers: [],
    missingSourceRows: [],
    sourceCounts: {
      event: 0,
      worker_event: 0,
      worker: 0,
      state: 0,
      gate: 0,
      artifact: 0,
      decision: 0
    },
    repair: `Timeline integrity check failed: ${error instanceof Error ? error.message : String(error)}`
  };
}
