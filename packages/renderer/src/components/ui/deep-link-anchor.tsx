import type { DeepLinkTarget } from "@buildwarden/shared";
import type { MouseEvent, ReactNode } from "react";
import { useDeepLinkNavigation } from "../../lib/deep-links";

/**
 * A link to a BuildWarden run, chat, or project inside rendered content. It navigates in place
 * rather than asking the OS or a new tab to open the app again. Outside an app shell there is
 * nowhere to navigate, so it renders as text instead of a link the window would try to follow.
 */
export function DeepLinkAnchor({ target, href, className, children }: {
  target: DeepLinkTarget;
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useDeepLinkNavigation();
  if (!navigate) return <span>{children}</span>;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate(target);
  };
  return <a href={href} className={className} title={`Open ${target.kind} in BuildWarden`} onClick={handleClick}>{children}</a>;
}
