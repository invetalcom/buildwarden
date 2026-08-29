import { useEffect, useId, useState } from "react";
import { reportRendererError, reportRendererLog, reportRendererWarning } from "../../lib/report-renderer-error";
import { Card } from "../ui/card";

interface ProjectInsightMermaidProps {
  chart: string;
  emptyLabel?: string;
}

export const ProjectInsightMermaid = ({ chart, emptyLabel = "No graph generated yet." }: ProjectInsightMermaidProps) => {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  const id = useId().replace(/:/g, "_");

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeRevision((current) => current + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "data-design-scheme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!chart.trim()) {
      reportRendererWarning("renderer.project-graphs.mermaid.empty-chart", "Graph render skipped because chart text is empty.", {
        graphId: id,
      });
      setSvg("");
      setError(null);
      return;
    }
    reportRendererLog({
      level: "warn",
      source: "renderer.project-graphs.mermaid.render.start",
      message: "Rendering Mermaid project graph.",
      metadata: {
        graphId: id,
        chartLength: chart.length,
      },
    });
    void import("mermaid")
      .then(({ default: mermaid }) => {
        const styles = getComputedStyle(document.documentElement);
        const token = (name: string) => styles.getPropertyValue(name).trim();
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          securityLevel: "loose",
          themeVariables: {
            background: token("--ec-panel"),
            primaryColor: token("--ec-panel-strong"),
            primaryTextColor: token("--ec-text"),
            primaryBorderColor: token("--ec-accent"),
            secondaryColor: token("--ec-secondary-soft"),
            tertiaryColor: token("--ec-accent-soft"),
            lineColor: token("--ec-muted"),
            textColor: token("--ec-text"),
            titleColor: token("--ec-text"),
            edgeLabelBackground: token("--ec-bg-elevated"),
            clusterBkg: token("--ec-panel-soft"),
            clusterBorder: token("--ec-border-strong"),
          },
        });
        return mermaid.render(`project-insight-${id}`, chart);
      })
      .then((result) => {
        if (!cancelled) {
          reportRendererLog({
            level: "warn",
            source: "renderer.project-graphs.mermaid.render.success",
            message: "Rendered Mermaid project graph.",
            metadata: {
              graphId: id,
              svgLength: result.svg.length,
            },
          });
          setSvg(result.svg);
          setError(null);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          reportRendererError("renderer.project-graphs.mermaid.render.failure", caught, {
            graphId: id,
            chartLength: chart.length,
          });
          setSvg("");
          setError(caught instanceof Error ? caught.message : "Could not render graph.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart, id, themeRevision]);

  return (
    <Card className="overflow-hidden border-[var(--ec-border)] bg-[var(--ec-panel)] p-0">
      {error ? <div className="px-4 py-6 text-sm text-[var(--ec-danger)]">{error}</div> : null}
      {!error && !svg ? <div className="px-4 py-6 text-sm text-[var(--ec-muted)]">{emptyLabel}</div> : null}
      {svg ? (
        <div
          className="app-scrollbar overflow-auto px-2 py-2 [&_svg]:min-w-[720px] [&_svg]:bg-transparent"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : null}
    </Card>
  );
};
