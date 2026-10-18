import { memo, useMemo, useState } from "react";
import { safeResponseImageUrl } from "./response-markdown";
import { ImageLightbox } from "./image-lightbox";

export const ResponseImage = memo(function ResponseImage({ src, alt = "", title }: { src?: string; alt?: string; title?: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const url = useMemo(() => safeResponseImageUrl(src ?? ""), [src]);
  if (!url || failedSource === url) return <span className="response-image-unavailable" role="img" aria-label={alt || "Image unavailable"}>{alt ? `${alt} — image unavailable` : "Image unavailable"}</span>;
  return <>
    <button type="button" className="response-image-button" onClick={() => setOpen(true)} aria-label={`Enlarge ${alt || "image"}`}>
      <img src={url} alt={alt} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedSource(url)} />
    </button>
    {open ? <ImageLightbox imageUrl={url} downloadFileName="response-image" title={alt || title || "Image"} onClose={() => setOpen(false)} /> : null}
  </>;
});
