import type { JSX } from "react";

export function EmptyState({ title, message }: { title: string; message: string }): JSX.Element {
  return (
    <section className="soft-state">
      <h2>{title}</h2>
      <p>{message}</p>
    </section>
  );
}
