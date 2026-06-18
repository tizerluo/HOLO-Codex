import type { JSX } from "react";
import { useEffect, useState } from "react";

export interface ResponsiveTableRow {
  key: string;
  cells: Array<string | JSX.Element>;
  cardTitle?: string;
  cardMeta?: string;
  cardSummary?: string;
}

export function Table({ columns, rows, empty }: { columns: string[]; rows: Array<Array<string | JSX.Element>>; empty: string; }): JSX.Element {
  return <ResponsiveTable columns={columns} rows={rows.map((cells, index) => ({ key: String(index), cells }))} empty={empty} />;
}

export function ResponsiveTable({ columns, rows, empty }: { columns: string[]; rows: ResponsiveTableRow[]; empty: string; }): JSX.Element {
  const compact = useCompactTable();
  if (compact) {
    return (
      <section className="table-panel table-panel--compact">
        <div className="compact-card-list" aria-label="Compact data">
          {rows.length === 0 ? <article className="compact-data-card"><p>{empty}</p></article> : rows.map((row) => (
            <article className="compact-data-card" key={row.key}>
              <div className="compact-data-card__head">
                <strong>{row.cardTitle ?? String(row.cells[0] ?? "")}</strong>
                {row.cardMeta ? <span>{row.cardMeta}</span> : null}
              </div>
              {row.cardSummary ? <p>{row.cardSummary}</p> : null}
              <dl>
                {columns.map((column, index) => (
                  <div key={column}>
                    <dt>{column}</dt>
                    <dd>{row.cells[index] ?? "-"}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
      </section>
    );
  }
  return (
    <section className="table-panel">
      <table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.length === 0 ? <tr><td colSpan={columns.length} className="empty-cell">{empty}</td></tr> : rows.map((row) => <tr key={row.key}>{row.cells.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>
    </section>
  );
}

function useCompactTable(): boolean {
  const [compact, setCompact] = useState(() => compactTableMatches());
  useEffect(() => {
    const update = (): void => setCompact(compactTableMatches());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return compact;
}

function compactTableMatches(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") return window.matchMedia("(max-width: 560px)").matches;
  return window.innerWidth <= 560;
}
