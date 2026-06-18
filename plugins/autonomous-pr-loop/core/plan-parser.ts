import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface PlanPrItem {
  id: string;
  title: string;
  status: "completed" | "current" | "next" | "unknown";
  file: string;
  dependsOn: string[];
  issueRefs: string[];
  whySelected?: string;
}

export interface PlanNavigatorModel {
  convention: string;
  currentMilestone: string;
  selectedNext?: PlanPrItem;
  completed: PlanPrItem[];
  candidates: PlanPrItem[];
  ambiguous: boolean;
  evidence: string[];
}

interface SpecIndex {
  orderedIds: string[];
  completedIds: Set<string>;
}

/** Parse documented PR plan/spec files for the dashboard Plan Navigator. */
export function parsePlanNavigator(repoRoot: string, plansDir: string): PlanNavigatorModel {
  const convention = "PR plan documents use files named pr-<letter>-<slug>.md with a top-level `# PR X ...` heading; legacy spec indexes are supported when present.";
  const specDir = join(repoRoot, "docs", "specs");
  const planDir = join(repoRoot, plansDir);
  const specIndex = readSpecIndex(specDir);
  const files = [
    ...markdownFiles(specDir).filter((file) => /^pr-[a-z0-9]+-/i.test(basename(file))),
    ...markdownFiles(planDir)
  ];
  const items = files.map((file) => parsePlanFile(file)).filter((item): item is PlanPrItem => item !== undefined);
  const unique = inferStatuses(dedupeById(items).sort(compareBySpecIndex(specIndex)), specIndex);
  const completed = unique.filter((item) => item.status === "completed");
  const candidates = unique.filter((item) => item.status === "next" || item.status === "current" || item.status === "unknown");
  const nextCandidates = candidates.filter((item) => item.status === "next");
  const selectedNext = nextCandidates.length === 1 ? nextCandidates[0] : candidates[0];
  return {
    convention,
    currentMilestone: selectedNext?.id ?? completed.at(-1)?.id ?? "unknown",
    ...(selectedNext ? { selectedNext } : {}),
    completed,
    candidates,
    ambiguous: nextCandidates.length > 1 || (!selectedNext && unique.length === 0),
    evidence: evidenceFor(unique, nextCandidates)
  };
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(dir, name));
}

function readSpecIndex(specDir: string): SpecIndex {
  const readmePath = join(specDir, "README.md");
  if (!existsSync(readmePath)) {
    return { orderedIds: [], completedIds: new Set() };
  }
  const text = readFileSync(readmePath, "utf8");
  const completedIds = new Set<string>();
  const orderedIds: string[] = [];
  let inFutureSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (isFutureSpecSection(line)) {
      inFutureSection = true;
    }
    const id = /^\s*\d+\.\s+\[PR\s+([A-Z0-9]+)/i.exec(line)?.[1]?.toUpperCase();
    if (!id) {
      continue;
    }
    const normalized = `PR ${id}`;
    orderedIds.push(normalized);
    if (!inFutureSection) {
      completedIds.add(normalized);
    }
  }
  return { orderedIds, completedIds };
}

function isFutureSpecSection(line: string): boolean {
  return /(?:后续|未来|待办)\s*PR\s*顺序/i.test(line) || /future\s+PR\s+order/i.test(line);
}

function parsePlanFile(file: string): PlanPrItem | undefined {
  const text = readFileSync(file, "utf8");
  const heading = /^#\s+(?:SPEC[:：]\s*)?(PR\s+[A-Z0-9]+[^\n]*)/m.exec(text)?.[1];
  const id = /PR\s+([A-Z0-9]+)/i.exec(heading ?? basename(file))?.[1]?.toUpperCase();
  if (!id) {
    return undefined;
  }
  const markerStatus = /status:\s*(completed|current|next|unknown)/i.exec(text)?.[1]?.toLowerCase();
  return {
    id: `PR ${id}`,
    title: heading ?? basename(file, ".md"),
    status: statusFromMarker(markerStatus),
    file,
    dependsOn: [...text.matchAll(/depends(?:On| on)[:：]\s*([A-Z0-9,\s]+)/gi)].flatMap((match) =>
      (match[1] ?? "").split(/,\s*/).filter(Boolean)
    ),
    issueRefs: [...text.matchAll(/#(\d+)/g)].map((match) => `#${match[1]}`)
  };
}

function statusFromMarker(markerStatus: string | undefined): PlanPrItem["status"] {
  if (markerStatus === "completed" || markerStatus === "current" || markerStatus === "next" || markerStatus === "unknown") {
    return markerStatus;
  }
  return "unknown";
}

function inferStatuses(items: PlanPrItem[], specIndex: SpecIndex): PlanPrItem[] {
  if (items.some((item) => item.status === "next" || item.status === "current")) {
    return items.map((item) => item.status === "next" && item.whySelected === undefined
      ? { ...item, whySelected: "Marked next in the plan/spec document." }
      : item);
  }
  const indexedNext = specIndex.orderedIds.find((id) => !specIndex.completedIds.has(id) && items.some((item) => item.id === id));
  if (indexedNext) {
    return items.map((item) => {
      if (item.status !== "unknown") return item;
      if (specIndex.completedIds.has(item.id)) return { ...item, status: "completed" };
      if (item.id === indexedNext) {
        return { ...item, status: "next", whySelected: "Selected as the first uncompleted PR from the legacy spec index." };
      }
      return item;
    });
  }
  if (specIndex.orderedIds.length > 0) {
    return items.map((item) => item.status === "unknown" && specIndex.completedIds.has(item.id)
      ? { ...item, status: "completed" }
      : item);
  }
  const lastUnknownIndex = findLastIndex(items, (item) => item.status === "unknown");
  if (lastUnknownIndex < 0) {
    return items;
  }
  return items.map((item, index) => {
    if (item.status !== "unknown") return item;
    if (index === lastUnknownIndex) {
      return { ...item, status: "next", whySelected: "Selected as the highest uncompleted PR from parsed plan/spec documents." };
    }
    return { ...item, status: "completed" };
  });
}

function dedupeById(items: PlanPrItem[]): PlanPrItem[] {
  const map = new Map<string, PlanPrItem>();
  for (const item of items) {
    const existing = map.get(item.id);
    if (!existing || item.file.includes("/docs/specs/")) {
      map.set(item.id, item);
    }
  }
  return [...map.values()];
}

function evidenceFor(items: PlanPrItem[], nextCandidates: PlanPrItem[]): string[] {
  if (items.length === 0) {
    return ["No parseable PR plan/spec files found."];
  }
  if (nextCandidates.length > 1) {
    return nextCandidates.map((item) => `${item.id}: ${item.file}`);
  }
  return [`Parsed ${items.length} PR plan/spec documents.`];
}

function compareBySpecIndex(specIndex: SpecIndex): (a: PlanPrItem, b: PlanPrItem) => number {
  return (a, b) => {
    const left = specIndex.orderedIds.indexOf(a.id);
    const right = specIndex.orderedIds.indexOf(b.id);
    if (left >= 0 && right >= 0) return left - right;
    if (left >= 0) return -1;
    if (right >= 0) return 1;
    return comparePlanItems(a, b);
  };
}

function comparePlanItems(a: PlanPrItem, b: PlanPrItem): number {
  return planSortKey(a.id).localeCompare(planSortKey(b.id), undefined, { numeric: true });
}

function planSortKey(id: string): string {
  const value = /PR\s+([A-Z]+)(\d*)/i.exec(id);
  if (!value) {
    return id;
  }
  return `${value[1]}${value[2] ? value[2].padStart(3, "0") : "000"}`;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) return index;
  }
  return -1;
}
