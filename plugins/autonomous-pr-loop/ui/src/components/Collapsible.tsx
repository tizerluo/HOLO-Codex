import type { JSX } from "react";
import { StatusBadge } from "./StatusBadge.js";

export function Collapsible({ title, chip, children, defaultOpen = false }: { title: string; chip: string; children: JSX.Element; defaultOpen?: boolean }): JSX.Element {
  return <details className="disclosure-panel" open={defaultOpen}><summary><span>{title}</span><StatusBadge value={chip} tone="blue" /></summary>{children}</details>;
}
