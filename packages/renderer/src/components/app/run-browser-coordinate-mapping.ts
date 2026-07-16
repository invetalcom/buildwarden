import type { RunBrowserFrame } from "@buildwarden/shared";

export const mapRunBrowserFramePoint = (
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  frame: Pick<RunBrowserFrame, "width" | "height">,
): { x: number; y: number } | null => {
  if (bounds.width < 1 || bounds.height < 1 || frame.width < 1 || frame.height < 1) return null;
  const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height);
  const renderedWidth = frame.width * scale;
  const renderedHeight = frame.height * scale;
  const renderedLeft = bounds.left + (bounds.width - renderedWidth) / 2;
  const renderedTop = bounds.top + (bounds.height - renderedHeight) / 2;
  if (clientX < renderedLeft || clientX > renderedLeft + renderedWidth ||
    clientY < renderedTop || clientY > renderedTop + renderedHeight) return null;
  return {
    x: Math.max(0, Math.min(frame.width, ((clientX - renderedLeft) / renderedWidth) * frame.width)),
    y: Math.max(0, Math.min(frame.height, ((clientY - renderedTop) / renderedHeight) * frame.height)),
  };
};
