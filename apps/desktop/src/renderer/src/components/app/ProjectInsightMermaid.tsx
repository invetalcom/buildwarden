import { useEffect, useId, useState } from "react";
import { reportRendererError, reportRendererLog, reportRendererWarning } from "../../lib/report-renderer-error";
import { Card } from "../ui/card";

interface ProjectInsightMermaidProps {
  chart: string;
  emptyLabel?: string;
}

let mermaidInitialized = false;

export const ProjectInsightMermaid = ({ chart, emptyLabel = "No graph generated yet." }: ProjectInsightMermaidProps) => {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const id = useId().replace(/:/g, "_");

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
        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            theme: "dark",
            securityLevel: "loose",
          });
          mermaidInitialized = true;
        }
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
  }, [chart, id]);

  return (
    <Card className="overflow-hidden border-zinc-800/80 bg-zinc-950/60 p-0">
      {error ? <div className="px-4 py-6 text-sm text-rose-300">{error}</div> : null}
      {!error && !svg ? <div className="px-4 py-6 text-sm text-zinc-500">{emptyLabel}</div> : null}
      {svg ? (
        <div
          className="app-scrollbar overflow-auto px-2 py-2 [&_svg]:min-w-[720px] [&_svg]:bg-transparent"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : null}
    </Card>
  );
};
