import { TerminalSquare } from "lucide-react";
import type { JSX } from "react";

export function CommandPreview({ commands, emptyMessage }: { commands: string[]; emptyMessage: string }): JSX.Element {
  return (
    <div className="command-list">
      {commands.length === 0 ? <p className="muted-copy">{emptyMessage}</p> : commands.map((command) => (
        <div className="command-line" key={command}>
          <TerminalSquare size={15} />
          <code>{command}</code>
        </div>
      ))}
    </div>
  );
}
