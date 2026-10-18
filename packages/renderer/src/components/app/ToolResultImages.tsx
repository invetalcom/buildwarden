import { presentToolResult } from "@buildwarden/shared";

export const ToolResultImages = ({ images }: { images: unknown }) => {
  const safe = presentToolResult(Array.isArray(images) ? images.map((image: unknown) => (
    image && typeof image === "object" ? { ...image, type: "image" } : null
  )) : []).images;
  if (!safe.length) return null;
  return <div className="flex flex-wrap gap-2 py-2">{safe.map((image, index) => (
    <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`Tool screenshot ${index + 1}`} loading="lazy" className="max-h-80 max-w-full rounded border border-[var(--ec-border)] object-contain" />
  ))}</div>;
};
