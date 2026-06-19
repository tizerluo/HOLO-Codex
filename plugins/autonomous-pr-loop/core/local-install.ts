import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runCommand } from "./command.js";
import { isRecord } from "./config.js";
import { AgentLoopError } from "./errors.js";
import { commandsReferencingLegacyPrivateRepo, inspectAgentLoopBinary, inspectBundledHooksConfig, redactDiagnosticText, type AgentLoopBinaryInspection, type BundledHooksConfigInspection } from "./hook-diagnostics.js";
import { agentLoopRouterHookCommand, collectHookCommands, isLegacyAgentLoopHookCommand } from "./hook-installation.js";
import { CODEX_HOOK_EVENTS, hookScriptName } from "./hook-events.js";
import { hookRegistryPath, inspectHookRegistryLock, listHookBindings } from "./hook-router.js";
import { defaultPackageRoot, hookDistRoot, hookSourceRoot } from "./plugin-paths.js";

export interface LocalInstallOptions {
  repoRoot: string;
  packageRoot?: string;
  allowDirty?: boolean;
}

export interface LocalInstallResult {
  ok: true;
  packageRoot: string;
  repoRoot: string;
  snapshotPath: string;
  manifestChanges: string[];
  install: {
    buildHooks: CommandSummary;
    globalInstall: CommandSummary;
    installHooks: CommandSummary;
  };
  localDoctor: LocalDoctorReport;
  repoDoctor: CommandSummary;
  rollbackCommand: string;
}

export interface LocalRollbackOptions {
  snapshotPath: string;
  packageRoot?: string;
}

export interface LocalRollbackResult {
  ok: true;
  snapshotPath: string;
  restored: string[];
  removed: string[];
  preservedBrokenFiles: string[];
  warnings: string[];
  globalUninstall: CommandSummary;
  localDoctor: LocalDoctorReport;
}

export interface LocalSnapshotEntry {
  path: string;
  createdAt?: string;
  repoRoot?: string;
  packageRoot?: string;
  invalid?: boolean;
  error?: string;
}

export interface LocalSnapshotList {
  ok: true;
  backupsDir: string;
  snapshots: LocalSnapshotEntry[];
}

export interface LocalSnapshotPruneOptions {
  keep: number;
  apply?: boolean;
}

export interface LocalSnapshotPruneResult {
  ok: true;
  backupsDir: string;
  keep: number;
  apply: boolean;
  kept: LocalSnapshotEntry[];
  candidates: LocalSnapshotEntry[];
  deleted: string[];
  warnings: string[];
}

export interface LocalDoctorReport {
  ok: true;
  packageRoot: string;
  repoRoot: string;
  codexHome: string;
  binary: {
    path?: string;
    realPath?: string;
    expectedPackageRoot: string;
    pointsToExpectedPackage: boolean;
    referencesExpectedPackage: boolean;
    legacyPrivateRepoReferences: string[];
    readError?: string;
  };
  hooks: {
    hooksPath: string;
    hooksJsonError?: string;
    bundledHooksConfig: BundledHooksConfigInspection;
    routerInstalled: boolean;
    missingRouterEvents: string[];
    legacyCommands: string[];
    legacyPrivateRepoCommands: string[];
    routerCommandsPointToExpectedDist: boolean;
  };
  bindings: {
    registryPath: string;
    activeBindings: number;
    currentRepoBindings: number;
    staleOrMissingPathBindings: number;
    tempPathBindings: number;
    lock: ReturnType<typeof inspectHookRegistryLock>;
    registryError?: string;
  };
  selfLinkPollution: {
    clean: boolean;
    files: string[];
  };
}

interface SnapshotManifest {
  version: 1;
  createdAt: string;
  packageRoot: string;
  repoRoot: string;
  codexHome: string;
  files: Array<{ name: string; originalPath: string; existed: boolean; backupPath?: string }>;
  targetAgentLoop: {
    path: string;
    exists: boolean;
    entries: Array<{ path: string; size: number }>;
  };
}

export interface CommandSummary {
  ok: boolean;
  command: string;
  stdout?: string;
  stderr?: string;
}

type HookBindingRegistryJson = { version: 1; bindings: unknown[] };
type ManifestSnapshot = Map<string, { hash?: string; content?: Buffer }>;
const LEGACY_NPM_PACKAGE_NAME = "codex-auto-pr-loop-plugin";
const FALLBACK_NPM_PACKAGE_NAME = "holo-codex";

/** Install the local agent-loop CLI and hook router with a reversible snapshot. */
export function installLocalAgentLoop(options: LocalInstallOptions): LocalInstallResult {
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const repoRoot = canonicalPath(options.repoRoot);
  const dirty = gitStatus(packageRoot);
  if (!options.allowDirty && dirty.length > 0) {
    throw new AgentLoopError("invalid_config", `Plugin worktree is dirty. Commit/stash changes or rerun with --allow-dirty.\n${dirty.join("\n")}`, {
      details: { dirty }
    });
  }

  const beforeManifests = manifestSnapshots(packageRoot);
  const snapshotPath = createLocalInstallSnapshot({ packageRoot, repoRoot });
  const buildHooks = buildHooksForLocalInstall(packageRoot);
  if (!buildHooks.ok) {
    throw localInstallFailure(`Failed to build hooks before local install.\n${buildHooks.stderr ?? buildHooks.stdout ?? ""}`, snapshotPath);
  }
  const globalInstall = runCommandSummary("pnpm", ["add", "--global", packageRoot], homedir());
  const afterGlobalHashes = manifestSnapshots(packageRoot);
  const globalManifestChanges = changedManifestFiles(beforeManifests, afterGlobalHashes);
  if (globalManifestChanges.length > 0) {
    restoreManifestFiles(packageRoot, beforeManifests, globalManifestChanges);
    throw localInstallFailure(`Global install changed repository manifests: ${globalManifestChanges.join(", ")}`, snapshotPath, globalManifestChanges);
  }
  if (!globalInstall.ok) {
    throw localInstallFailure(`Failed to install global agent-loop CLI.\n${globalInstall.stderr ?? globalInstall.stdout ?? ""}`, snapshotPath);
  }

  const installHooks = runCommandSummary("pnpm", ["agent-loop", "install-hooks", "--repo", repoRoot, "--json"], packageRoot);
  const afterHooksHashes = manifestSnapshots(packageRoot);
  const manifestChanges = changedManifestFiles(beforeManifests, afterHooksHashes);
  if (manifestChanges.length > 0) {
    restoreManifestFiles(packageRoot, beforeManifests, manifestChanges);
    throw localInstallFailure(`Local install changed repository manifests: ${manifestChanges.join(", ")}`, snapshotPath, manifestChanges);
  }
  if (!installHooks.ok) {
    throw localInstallFailure(`Failed to install hook router.\n${installHooks.stderr ?? installHooks.stdout ?? ""}`, snapshotPath);
  }

  const localDoctor = inspectLocalInstall({ repoRoot, packageRoot });
  const repoDoctor = runCommandSummary("pnpm", ["agent-loop", "--repo", repoRoot, "doctor", "--json"], packageRoot);

  return {
    ok: true,
    packageRoot,
    repoRoot,
    snapshotPath,
    manifestChanges,
    install: { buildHooks, globalInstall, installHooks },
    localDoctor,
    repoDoctor,
    rollbackCommand: `agent-loop local rollback --snapshot ${shellQuote(snapshotPath)}`
  };
}

function buildHooksForLocalInstall(packageRoot: string): CommandSummary {
  const distReady = CODEX_HOOK_EVENTS
    .map((event) => join(hookDistRoot(packageRoot), hookScriptName(event)))
    .every((script) => existsSync(script));
  const sourceCheckout = existsSync(join(packageRoot, "pnpm-lock.yaml"));
  if (distReady && !sourceCheckout) {
    return {
      ok: true,
      command: `pnpm build:hooks`,
      stdout: "Skipped hook build because packaged hook dist is already present."
    };
  }
  if (!existsSync(hookSourceRoot(packageRoot)) && distReady) {
    return {
      ok: true,
      command: `pnpm build:hooks`,
      stdout: "Skipped hook build because hook sources are unavailable and packaged hook dist is present."
    };
  }
  return runCommandSummary("pnpm", ["build:hooks"], packageRoot);
}

/** Restore hook/router state from a local-install snapshot and remove the global CLI link. */
export function rollbackLocalAgentLoop(options: LocalRollbackOptions): LocalRollbackResult {
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const snapshotPath = resolve(options.snapshotPath);
  const manifest = readSnapshotManifest(snapshotPath);
  const restored: string[] = [];
  const removed: string[] = [];
  const preservedBrokenFiles: string[] = [];
  const warnings: string[] = [];

  for (const file of manifest.files) {
    if (file.name === "hooks") {
      const result = rollbackHooksFile(file, snapshotPath, manifest.packageRoot);
      restored.push(...result.restored);
      removed.push(...result.removed);
      preservedBrokenFiles.push(...result.preservedBrokenFiles);
      warnings.push(...result.warnings);
      continue;
    }
    if (file.name === "hook-bindings") {
      const result = rollbackBindingRegistryFile(file, snapshotPath, manifest.repoRoot);
      restored.push(...result.restored);
      removed.push(...result.removed);
      preservedBrokenFiles.push(...result.preservedBrokenFiles);
      warnings.push(...result.warnings);
      continue;
    }
  }

  const packageName = localPackageName(packageRoot);
  const globalUninstall = runCommandSummary("pnpm", ["remove", "--global", packageName], homedir());
  if (!globalUninstall.ok) {
    warnings.push("Global CLI uninstall did not complete; inspect `pnpm list --global --depth 0` manually.");
  }
  if (packageName !== LEGACY_NPM_PACKAGE_NAME) {
    runCommandSummary("pnpm", ["remove", "--global", LEGACY_NPM_PACKAGE_NAME], homedir());
  }

  return {
    ok: true,
    snapshotPath,
    restored,
    removed,
    preservedBrokenFiles,
    warnings,
    globalUninstall,
    localDoctor: inspectLocalInstall({ repoRoot: manifest.repoRoot, packageRoot })
  };
}

function rollbackHooksFile(file: SnapshotManifest["files"][number], snapshotPath: string, packageRoot: string): { restored: string[]; removed: string[]; preservedBrokenFiles: string[]; warnings: string[] } {
  const restored: string[] = [];
  const removed: string[] = [];
  const preservedBrokenFiles: string[] = [];
  const warnings: string[] = [];
  const managedCommands = new Set(CODEX_HOOK_EVENTS.map((event) => agentLoopRouterHookCommand(event, packageRoot)));
  if (!existsSync(file.originalPath)) {
    if (file.existed && file.backupPath) {
      mkdirSync(dirname(file.originalPath), { recursive: true });
      copyFileSync(join(snapshotPath, file.backupPath), file.originalPath);
      restored.push(file.originalPath);
    }
    return { restored, removed, preservedBrokenFiles, warnings };
  }

  let currentHooks: unknown;
  try {
    currentHooks = JSON.parse(readFileSync(file.originalPath, "utf8")) as unknown;
  } catch (error) {
    const preserved = preserveBrokenFile(file.originalPath);
    preservedBrokenFiles.push(preserved);
    warnings.push(`Current hooks.json is malformed; preserved ${preserved} and restored snapshot instead. ${error instanceof Error ? error.message : String(error)}`);
    restoreOrRemoveSnapshotFile(file, snapshotPath, restored, removed);
    return { restored, removed, preservedBrokenFiles, warnings };
  }

  const stripped = stripManagedHookCommands(currentHooks, managedCommands);
  if (stripped.removed === 0 && file.existed && file.backupPath) {
    warnings.push("No matching agent-loop router hook command was found during rollback; hooks.json was left unchanged.");
    return { restored, removed, preservedBrokenFiles, warnings };
  }
  mkdirSync(dirname(file.originalPath), { recursive: true });
  writeFileSync(file.originalPath, `${JSON.stringify(stripped.value, null, 2)}\n`, { mode: 0o600 });
  restored.push(file.originalPath);
  return { restored, removed, preservedBrokenFiles, warnings };
}

function rollbackBindingRegistryFile(file: SnapshotManifest["files"][number], snapshotPath: string, repoRoot: string): { restored: string[]; removed: string[]; preservedBrokenFiles: string[]; warnings: string[] } {
  const restored: string[] = [];
  const removed: string[] = [];
  const preservedBrokenFiles: string[] = [];
  const warnings: string[] = [];
  const snapshotRegistry = file.existed && file.backupPath
    ? readHookBindingRegistryJson(join(snapshotPath, file.backupPath))
    : { version: 1 as const, bindings: [] };
  const repoKey = canonicalPath(repoRoot);

  if (!existsSync(file.originalPath)) {
    const snapshotRepoBindings = snapshotRegistry.bindings.filter((binding) => bindingMatchesRepo(binding, repoKey));
    if (snapshotRepoBindings.length > 0) {
      writeHookBindingRegistryJson(file.originalPath, { version: 1, bindings: snapshotRepoBindings });
      restored.push(file.originalPath);
    }
    return { restored, removed, preservedBrokenFiles, warnings };
  }

  let currentRegistry: HookBindingRegistryJson;
  try {
    currentRegistry = readHookBindingRegistryJson(file.originalPath);
  } catch (error) {
    const preserved = preserveBrokenFile(file.originalPath);
    preservedBrokenFiles.push(preserved);
    warnings.push(`Current hook binding registry is malformed; preserved ${preserved} and restored snapshot instead. ${error instanceof Error ? error.message : String(error)}`);
    restoreOrRemoveSnapshotFile(file, snapshotPath, restored, removed);
    return { restored, removed, preservedBrokenFiles, warnings };
  }

  const keptCurrent = currentRegistry.bindings.filter((binding) => !bindingMatchesRepo(binding, repoKey));
  const snapshotRepoBindings = snapshotRegistry.bindings.filter((binding) => bindingMatchesRepo(binding, repoKey));
  const merged = dedupeBindingsById([...keptCurrent, ...snapshotRepoBindings]);
  if (merged.length === 0 && !file.existed) {
    rmSync(file.originalPath, { force: true });
    removed.push(file.originalPath);
    return { restored, removed, preservedBrokenFiles, warnings };
  }
  writeHookBindingRegistryJson(file.originalPath, { version: 1, bindings: merged });
  restored.push(file.originalPath);
  return { restored, removed, preservedBrokenFiles, warnings };
}

/** Inspect local install state without mutating hooks, bindings, or repo state. */
export function inspectLocalInstall(options: LocalInstallOptions): LocalDoctorReport {
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const repoRoot = canonicalPath(options.repoRoot);
  const codexHome = codexHomePath();
  const hooksPath = join(codexHome, "hooks.json");
  const binary = inspectAgentLoopBinary(packageRoot);
  const hooks = inspectHooks(hooksPath, packageRoot);
  const bindings = inspectBindings(codexHome, repoRoot);
  const selfLinkPollution = detectSelfLinkPollution(packageRoot);
  return {
    ok: true,
    packageRoot,
    repoRoot,
    codexHome,
    binary,
    hooks,
    bindings,
    selfLinkPollution
  };
}

/** List local-install snapshots under CODEX_HOME. */
export function listLocalInstallSnapshots(): LocalSnapshotList {
  const backupsDir = localInstallBackupsDir();
  if (!existsSync(backupsDir)) {
    return { ok: true, backupsDir, snapshots: [] };
  }
  const entries = readdirSafe(backupsDir)
    .filter((entry) => entry.startsWith("local-install-"))
    .map((entry) => join(backupsDir, entry))
    .filter((path) => existsSync(join(path, "snapshot.json")))
    .map((path) => {
      try {
        const manifest = readSnapshotManifest(path);
        return { path, createdAt: manifest.createdAt, repoRoot: manifest.repoRoot, packageRoot: manifest.packageRoot };
      } catch (error) {
        return { path, invalid: true, error: error instanceof Error ? error.message : String(error) };
      }
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return { ok: true, backupsDir, snapshots: entries };
}

/** Preview or delete old local-install snapshots under CODEX_HOME. */
export function pruneLocalInstallSnapshots(options: LocalSnapshotPruneOptions): LocalSnapshotPruneResult {
  if (!Number.isInteger(options.keep) || options.keep < 1) {
    throw new AgentLoopError("invalid_config", "local snapshots prune requires --keep with a positive integer.");
  }
  const backupsDir = localInstallBackupsDir();
  const warnings: string[] = [];
  if (!existsSync(backupsDir)) {
    return { ok: true, backupsDir, keep: options.keep, apply: options.apply === true, kept: [], candidates: [], deleted: [], warnings };
  }
  const snapshots = readdirSafe(backupsDir)
    .filter((entry) => entry.startsWith("local-install-"))
    .map((entry) => join(backupsDir, entry))
    .filter((path) => existsSync(join(path, "snapshot.json")))
    .flatMap((path): LocalSnapshotEntry[] => {
      try {
        const manifest = readSnapshotManifest(path);
        if (Number.isNaN(Date.parse(manifest.createdAt))) {
          warnings.push(`Skipping snapshot with invalid createdAt: ${path}`);
          return [];
        }
        return [{ path, createdAt: manifest.createdAt, repoRoot: manifest.repoRoot, packageRoot: manifest.packageRoot }];
      } catch (error) {
        warnings.push(`Skipping malformed snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const kept = snapshots.slice(0, options.keep);
  const candidates = snapshots.slice(options.keep);
  const deleted: string[] = [];
  if (options.apply === true) {
    for (const snapshot of candidates) {
      try {
        rmSync(snapshot.path, { recursive: true, force: true });
        deleted.push(snapshot.path);
      } catch (error) {
        warnings.push(`Failed to delete snapshot ${snapshot.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { ok: true, backupsDir, keep: options.keep, apply: options.apply === true, kept, candidates, deleted, warnings };
}

function createLocalInstallSnapshot(input: { packageRoot: string; repoRoot: string }): string {
  const codexHome = codexHomePath();
  const snapshotPath = join(localInstallBackupsDir(), `local-install-${timestamp()}-${randomUUID().slice(0, 8)}`);
  mkdirSync(snapshotPath, { recursive: true });
  const files = [
    snapshotFile("hooks", join(codexHome, "hooks.json"), snapshotPath),
    snapshotFile("hook-bindings", hookRegistryPath(codexHome), snapshotPath)
  ];
  const manifest: SnapshotManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    packageRoot: input.packageRoot,
    repoRoot: input.repoRoot,
    codexHome,
    files,
    targetAgentLoop: agentLoopMetadata(input.repoRoot)
  };
  writeFileSync(join(snapshotPath, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return snapshotPath;
}

function snapshotFile(name: string, originalPath: string, snapshotPath: string): SnapshotManifest["files"][number] {
  if (!existsSync(originalPath)) {
    return { name, originalPath, existed: false };
  }
  const backupPath = `${name}-${basename(originalPath)}`;
  copyFileSync(originalPath, join(snapshotPath, backupPath));
  return { name, originalPath, existed: true, backupPath };
}

function agentLoopMetadata(repoRoot: string): SnapshotManifest["targetAgentLoop"] {
  const path = join(repoRoot, ".agent-loop");
  if (!existsSync(path)) {
    return { path, exists: false, entries: [] };
  }
  return {
    path,
    exists: true,
    entries: readdirSafe(path).map((entry) => {
      const entryPath = join(path, entry);
      return { path: entry, size: statSync(entryPath).size };
    })
  };
}

function readSnapshotManifest(snapshotPath: string): SnapshotManifest {
  const parsed = JSON.parse(readFileSync(join(snapshotPath, "snapshot.json"), "utf8")) as SnapshotManifest;
  if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
    throw new Error(`Invalid local install snapshot: ${snapshotPath}`);
  }
  return parsed;
}

function restoreOrRemoveSnapshotFile(file: SnapshotManifest["files"][number], snapshotPath: string, restored: string[], removed: string[]): void {
  if (file.existed && file.backupPath) {
    mkdirSync(dirname(file.originalPath), { recursive: true });
    copyFileSync(join(snapshotPath, file.backupPath), file.originalPath);
    restored.push(file.originalPath);
  } else {
    rmSync(file.originalPath, { force: true });
    removed.push(file.originalPath);
  }
}

function preserveBrokenFile(path: string): string {
  const preserved = `${path}.broken-${timestamp()}`;
  try {
    copyFileSync(path, preserved);
    chmodSync(preserved, 0o600);
  } catch (error) {
    throw new AgentLoopError("storage_error", `Failed to preserve malformed file before rollback: ${path}`, {
      details: { sourcePath: path, preservePath: preserved, cause: error instanceof Error ? error.message : String(error) }
    });
  }
  return preserved;
}

function readHookBindingRegistryJson(path: string): HookBindingRegistryJson {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
    throw new Error(`Invalid hook binding registry: expected { version: 1, bindings: [...] } in ${path}`);
  }
  return { version: 1, bindings: parsed.bindings };
}

function writeHookBindingRegistryJson(path: string, registry: HookBindingRegistryJson): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
}

function bindingMatchesRepo(value: unknown, repoRoot: string): boolean {
  if (!isRecord(value)) return false;
  const bindingRepoRoot = typeof value.repoRoot === "string" ? canonicalPath(value.repoRoot) : undefined;
  const bindingWorktreeRoot = typeof value.worktreeRoot === "string" ? canonicalPath(value.worktreeRoot) : undefined;
  return bindingRepoRoot === repoRoot || bindingWorktreeRoot === repoRoot;
}

function dedupeBindingsById(bindings: unknown[]): unknown[] {
  const seen = new Set<string>();
  const output: unknown[] = [];
  for (const binding of bindings) {
    const id = isRecord(binding) && typeof binding.id === "string" ? binding.id : undefined;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    output.push(binding);
  }
  return output;
}

function stripManagedHookCommands(value: unknown, managedCommands: Set<string>): { value: unknown; removed: number } {
  const stripped = stripManagedHookCommandsInner(value, managedCommands);
  return { value: stripped.drop ? {} : stripped.value, removed: stripped.removed };
}

function stripManagedHookCommandsInner(value: unknown, managedCommands: Set<string>): { value: unknown; removed: number; drop: boolean } {
  if (Array.isArray(value)) {
    let removed = 0;
    const next: unknown[] = [];
    for (const item of value) {
      const stripped = stripManagedHookCommandsInner(item, managedCommands);
      removed += stripped.removed;
      if (!stripped.drop) next.push(stripped.value);
    }
    return { value: next, removed, drop: false };
  }
  if (!isRecord(value)) {
    return { value, removed: 0, drop: false };
  }
  if (value.type === "command" && typeof value.command === "string" && managedCommands.has(value.command)) {
    return { value: undefined, removed: 1, drop: true };
  }
  let removed = 0;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const stripped = stripManagedHookCommandsInner(child, managedCommands);
    removed += stripped.removed;
    if (!stripped.drop) next[key] = stripped.value;
  }
  if (Array.isArray(next.hooks) && next.hooks.length === 0 && Object.keys(next).every((key) => ["matcher", "hooks", "timeout", "statusMessage"].includes(key))) {
    return { value: undefined, removed, drop: true };
  }
  return { value: next, removed, drop: false };
}

function inspectHooks(hooksPath: string, packageRoot: string): LocalDoctorReport["hooks"] {
  let commands: string[] = [];
  let hooksJsonError: string | undefined;
  if (existsSync(hooksPath)) {
    try {
      commands = collectHookCommands(JSON.parse(readFileSync(hooksPath, "utf8")) as unknown);
    } catch (error) {
      commands = [];
      hooksJsonError = error instanceof Error ? error.message : String(error);
    }
  }
  const missingRouterEvents = CODEX_HOOK_EVENTS.filter((event) => !commands.includes(agentLoopRouterHookCommand(event, packageRoot)));
  const expectedDist = hookDistRoot(packageRoot);
  const routerCommands = commands.filter((command) => command.includes("autonomous-pr-loop/hooks/dist/"));
  const bundledHooksConfig = inspectBundledHooksConfig(packageRoot);
  return {
    hooksPath,
    ...(hooksJsonError ? { hooksJsonError } : {}),
    bundledHooksConfig,
    routerInstalled: missingRouterEvents.length === 0,
    missingRouterEvents,
    legacyCommands: commands.filter(isLegacyAgentLoopHookCommand).map(redactDiagnosticText),
    legacyPrivateRepoCommands: commandsReferencingLegacyPrivateRepo(commands),
    routerCommandsPointToExpectedDist: routerCommands.length > 0 && routerCommands.every((command) => command.includes(expectedDist))
  };
}

function inspectBindings(codexHome: string, repoRoot: string): LocalDoctorReport["bindings"] {
  try {
    const bindings = listHookBindings(codexHome);
    const active = bindings.filter((binding) => binding.status === "active");
    const staleOrMissingPathBindings = active.filter((binding) => !existsSync(binding.repoRoot)).length;
    const tempPathBindings = active.filter((binding) => binding.repoRoot.includes("/var/folders/") || binding.repoRoot.includes("/private/var/folders/")).length;
    return {
      registryPath: hookRegistryPath(codexHome),
      activeBindings: active.length,
      currentRepoBindings: active.filter((binding) => binding.repoRoot === repoRoot).length,
      staleOrMissingPathBindings,
      tempPathBindings,
      lock: inspectHookRegistryLock(codexHome)
    };
  } catch (error) {
    return {
      registryPath: hookRegistryPath(codexHome),
      activeBindings: 0,
      currentRepoBindings: 0,
      staleOrMissingPathBindings: 0,
      tempPathBindings: 0,
      lock: inspectHookRegistryLock(codexHome),
      registryError: error instanceof Error ? error.message : String(error)
    };
  }
}

function detectSelfLinkPollution(packageRoot: string): LocalDoctorReport["selfLinkPollution"] {
  const polluted = new Set<string>();
  const packageNames = new Set([localPackageName(packageRoot), LEGACY_NPM_PACKAGE_NAME]);
  const packageJsonPath = join(packageRoot, "package.json");
  if (existsSync(packageJsonPath)) {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const deps of [parsed.dependencies, parsed.devDependencies, parsed.optionalDependencies]) {
      for (const packageName of packageNames) {
        if (deps?.[packageName]?.startsWith("link:")) {
          polluted.add("package.json");
        }
      }
    }
  }
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const path = join(packageRoot, file);
    if (!existsSync(path)) {
      continue;
    }
    const content = readFileSync(path, "utf8");
    for (const packageName of packageNames) {
      if (new RegExp(`${escapeRegExp(packageName)}:\\s*link:`).test(content)) {
        polluted.add(file);
      }
    }
  }
  return { clean: polluted.size === 0, files: [...polluted] };
}

function localPackageName(packageRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : FALLBACK_NPM_PACKAGE_NAME;
  } catch {
    return FALLBACK_NPM_PACKAGE_NAME;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function manifestSnapshots(packageRoot: string): ManifestSnapshot {
  return new Map(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].map((file) => {
    const path = join(packageRoot, file);
    if (!existsSync(path)) {
      return [file, {}];
    }
    const content = readFileSync(path);
    return [file, { hash: sha256(content), content }];
  }));
}

function changedManifestFiles(before: ManifestSnapshot, after: ManifestSnapshot): string[] {
  return [...before.keys()].filter((file) => before.get(file)?.hash !== after.get(file)?.hash);
}

function restoreManifestFiles(packageRoot: string, before: ManifestSnapshot, changed: string[]): void {
  for (const file of changed) {
    const snapshot = before.get(file);
    const path = join(packageRoot, file);
    if (snapshot?.content) {
      writeFileSync(path, snapshot.content);
    } else {
      rmSync(path, { force: true });
    }
  }
}

function runCommandSummary(file: string, args: string[], cwd: string): CommandSummary {
  const result = runCommand(file, args, cwd);
  return {
    ok: result.ok,
    command: [file, ...args.map(shellQuote)].join(" "),
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {})
  };
}

function localInstallFailure(message: string, snapshotPath: string, manifestChanges: string[] = []): AgentLoopError {
  const rollbackCommand = `agent-loop local rollback --snapshot ${shellQuote(snapshotPath)}`;
  return new AgentLoopError("storage_error", `${message}\nSnapshot: ${snapshotPath}\nRollback: ${rollbackCommand}`, {
    details: {
      snapshotPath,
      rollbackCommand,
      ...(manifestChanges.length > 0 ? { manifestChanges } : {})
    }
  });
}

function gitStatus(cwd: string): string[] {
  const result = runCommand("git", ["status", "--short"], cwd);
  return result.ok && result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

function localInstallBackupsDir(): string {
  return join(codexHomePath(), "agent-loop", "backups");
}

function codexHomePath(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readdirSafe(path: string): string[] {
  try {
    return existsSync(path) ? readdirSync(path) : [];
  } catch {
    return [];
  }
}
