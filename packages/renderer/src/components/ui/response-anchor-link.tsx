import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { scrollToResponseAnchor } from "../../lib/response-anchors";

type ResponseAnchorLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; node?: unknown };

/** Same-response link. Never opens a window and never changes the app's URL hash. */
export const ResponseAnchorLink = ({ href, onClick, children, ...props }: ResponseAnchorLinkProps) => {
  const anchorProps = { ...props };
  delete anchorProps.node;
  delete anchorProps.target;
  delete anchorProps.rel;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    scrollToResponseAnchor(event.currentTarget, href);
  };
  return <a {...anchorProps} href={href} onClick={handleClick}>{children}</a>;
};
