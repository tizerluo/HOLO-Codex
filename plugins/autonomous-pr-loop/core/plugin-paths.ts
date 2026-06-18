import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the repository/package root that contains this plugin from a module URL. */
export function packageRootFromUrl(metaUrl: string): string {
  return resolve(dirname(fileURLToPath(metaUrl)), "../../..");
}

/** Resolve the repository/package root that contains this plugin. */
export function defaultPackageRoot(): string {
  return packageRootFromUrl(import.meta.url);
}

/** Resolve the HOLO-Codex plugin runtime directory. */
export function autonomousPrLoopRoot(packageRoot = defaultPackageRoot()): string {
  return join(packageRoot, "plugins", "autonomous-pr-loop");
}

/** Resolve the dashboard UI source directory bundled with this plugin. */
export function dashboardUiRoot(packageRoot = defaultPackageRoot()): string {
  return join(autonomousPrLoopRoot(packageRoot), "ui");
}

/** Resolve the hook source directory bundled with this plugin. */
export function hookSourceRoot(packageRoot = defaultPackageRoot()): string {
  return join(autonomousPrLoopRoot(packageRoot), "hooks");
}

/** Resolve the compiled hook runner directory bundled with this plugin. */
export function hookDistRoot(packageRoot = defaultPackageRoot()): string {
  return join(hookSourceRoot(packageRoot), "dist");
}
