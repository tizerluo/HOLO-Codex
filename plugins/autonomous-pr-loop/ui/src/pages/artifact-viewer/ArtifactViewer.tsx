import type { JSX } from "react";
import { useState } from "react";
import type { DashboardApi, MissionControlData } from "../../api.js";
import { ResponsiveTable } from "../../components/ResponsiveTable.js";
import { t } from "../../i18n.js";
import { decodeBase64Preview, formatTime, type ArtifactPreviewState, type EffectiveLocale } from "../CommandCenterParts.js";

export function ArtifactViewer({ api, data, preview, onPreview, locale }: { api: DashboardApi; data: MissionControlData; preview: ArtifactPreviewState | undefined; onPreview: (preview: ArtifactPreviewState) => void; locale: EffectiveLocale; }): JSX.Element {
  const [readingArtifactId, setReadingArtifactId] = useState<string>();
  const readArtifact = async (id: string): Promise<void> => {
    setReadingArtifactId(id);
    try {
      const result = await api.artifact(id);
      if (!result.ok || !result.data) {
        onPreview({ id, text: "", error: result.error?.message ?? t(locale, "artifactReadError") });
        return;
      }
      onPreview(decodeBase64Preview(id, result.data.contentBase64, locale));
    } catch (error) {
      onPreview({ id, text: "", error: error instanceof Error ? error.message : t(locale, "artifactReadError") });
    } finally {
      setReadingArtifactId(undefined);
    }
  };
  return (
    <div className="two-stack">
      <ResponsiveTable
        columns={[t(locale, "tableArtifact"), t(locale, "tableKind"), t(locale, "tablePath"), t(locale, "tableCreated"), t(locale, "tableAction")]}
        rows={data.artifacts.map((artifact) => ({
          key: artifact.id,
          cells: [artifact.name, artifact.kind, artifact.path, formatTime(artifact.createdAt), <button className="ghost-button" disabled={readingArtifactId !== undefined} key={artifact.id} type="button" onClick={() => void readArtifact(artifact.id)}>{readingArtifactId === artifact.id ? t(locale, "actionReading") : t(locale, "actionRead")}</button>],
          cardTitle: artifact.name,
          cardMeta: `${artifact.kind} / ${formatTime(artifact.createdAt)}`,
          cardSummary: artifact.path
        }))}
        empty={t(locale, "noArtifacts")}
      />
      <section className="artifact-preview" aria-label={t(locale, "artifactPreviewAria")}>
        <span>{preview ? `Artifact ${preview.id.slice(0, 8)}${preview.truncated ? ` / ${t(locale, "truncated")}` : ""}` : t(locale, "noArtifactSelected")}</span>
        <pre>{preview?.error ?? preview?.text ?? t(locale, "artifactSelectMessage")}</pre>
      </section>
    </div>
  );
}
