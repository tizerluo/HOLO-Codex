import { AlertTriangle } from "lucide-react";
import type { JSX } from "react";

export function ErrorState({ title, message }: { title: string; message: string }): JSX.Element {
  return (
    <section className="soft-state soft-state--error">
      <AlertTriangle size={18} />
      <h2>{title}</h2>
      <p>{message}</p>
    </section>
  );
}
