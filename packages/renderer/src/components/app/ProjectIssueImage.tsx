import { isForgeHostedImageUrl, type ProjectForgeProvider } from "@buildwarden/shared";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ResponseImage } from "../ui/response-image";

export interface IssueImageHost {
  provider: ProjectForgeProvider;
  webBaseUrl: string;
  /** Downloads an image of the open issue as a data URL. */
  load: (url: string) => Promise<string>;
}

/**
 * An image in an issue or comment. Images on the project's Git host load on their own, through the host
 * and with the saved token, so attachments of private repositories show too. Images from anywhere else
 * keep the usual "load this image?" prompt.
 */
export const ProjectIssueImage = ({ src, alt, title, host }: Readonly<{ src?: string; alt?: string; title?: string; host: IssueImageHost }>) => {
  const { provider, webBaseUrl, load } = host;
  const hostedSrc = src !== undefined && isForgeHostedImageUrl(provider, webBaseUrl, src) ? src : null;
  const [loaded, setLoaded] = useState<{ src: string; dataUrl: string | null } | null>(null);

  useEffect(() => {
    if (hostedSrc === null) return;
    let cancelled = false;
    load(hostedSrc).then(
      (dataUrl) => {
        if (!cancelled) setLoaded({ src: hostedSrc, dataUrl });
      },
      () => {
        if (!cancelled) setLoaded({ src: hostedSrc, dataUrl: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [hostedSrc, load]);

  if (hostedSrc === null) return <ResponseImage src={src} alt={alt} title={title} />;
  const current = loaded?.src === hostedSrc ? loaded : null;
  if (!current) {
    return (
      <span className="response-image-unavailable" role="status">
        <span className="flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
          Loading {alt?.trim() || "image"}…
        </span>
      </span>
    );
  }
  // When the host could not read it, the page may still be able to: fall back to the prompt that loads it directly.
  return <ResponseImage src={current.dataUrl ?? hostedSrc} alt={alt} title={title} />;
};
