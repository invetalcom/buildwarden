import type { AnchorHTMLAttributes } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { isExternalRunWorkspaceHref } from "@buildwarden/shared";
import { cn } from "../lib/cn";
import { markdownSanitizeSchema } from "../lib/markdown-sanitize";

/**
 * Renders agent and user messages as Markdown, with GFM (tables, task lists, strikethrough) and
 * sanitised raw HTML — the same pipeline the desktop UI uses, so a message reads the same on both.
 * Only the component markup is mobile-specific.
 *
 * Mobile rules that differ from the desktop renderer:
 * - Anything that can be wider than the screen (code blocks, tables) scrolls inside its own box.
 *   The page itself must never scroll horizontally.
 * - Long URLs and paths wrap rather than stretch their container.
 * - Links open in a new tab; workspace-relative references are not navigable from a browser, so
 *   they render as plain text instead of a link that would go nowhere.
 *
 * Do not pass git diffs here — `DiffViewer` handles those.
 */

const MobileLink = ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => {
  // Workspace file references ("src/index.ts", "file://…") mean nothing to a mobile browser.
  if (!href || !isExternalRunWorkspaceHref(href)) {
    return <span className="m-wrap-anywhere text-[var(--ec-muted)]">{children}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="m-wrap-anywhere text-[var(--ec-accent)] underline decoration-[var(--ec-accent-ring)] underline-offset-2"
      {...props}
    >
      {children}
    </a>
  );
};

const components: Components = {
  p: ({ children }) => <p className="m-wrap-anywhere my-1.5 leading-6 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-[var(--ec-muted)] line-through">{children}</del>,
  a: MobileLink,

  h1: ({ children }) => <h1 className="m-wrap-anywhere mb-1.5 mt-3 text-[16px] font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="m-wrap-anywhere mb-1.5 mt-3 text-[15px] font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="m-wrap-anywhere mb-1 mt-2.5 text-[14px] font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="m-wrap-anywhere mb-1 mt-2 text-[13.5px] font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="m-wrap-anywhere mb-1 mt-2 text-[13px] font-semibold first:mt-0">{children}</h5>,
  h6: ({ children }) => (
    <h6 className="m-wrap-anywhere mb-1 mt-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--ec-muted)] first:mt-0">
      {children}
    </h6>
  ),

  ul: ({ children }) => (
    <ul className="my-1.5 list-outside list-disc space-y-1 pl-5 marker:text-[var(--ec-accent)]">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-outside list-decimal space-y-1 pl-5 marker:text-[var(--ec-accent)]">{children}</ol>
  ),
  li: ({ children }) => <li className="m-wrap-anywhere leading-6 [&>p]:my-0.5">{children}</li>,

  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-[var(--ec-border-strong)] bg-[var(--ec-panel-soft)] py-1 pl-3 text-[var(--ec-muted)] [&>p]:my-0.5">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-[var(--ec-border)]" />,

  // Fenced blocks own their horizontal scroll so a long line never widens the screen.
  pre: ({ children }) => (
    <pre className="m-scroll-thin m-mono my-2 overflow-x-auto rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-2.5 py-2 text-[12px] leading-5">
      {children}
    </pre>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={cn("m-mono text-[12px]", className)} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="m-mono m-wrap-anywhere rounded bg-[var(--ec-control)] px-1 py-0.5 text-[0.92em]" {...props}>
        {children}
      </code>
    );
  },

  table: ({ children }) => (
    <div className="m-scroll-thin my-2 max-w-full overflow-x-auto rounded-md border border-[var(--ec-border)]">
      <table className="w-full border-collapse text-left text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-[var(--ec-border)] bg-[var(--ec-panel-soft)]">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-[var(--ec-border)]">{children}</tbody>,
  th: ({ children }) => <th className="whitespace-nowrap px-2 py-1.5 font-medium">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1.5 align-top text-[var(--ec-muted)]">{children}</td>,

  img: ({ src, alt, title }) => {
    // Sanitisation strips a disallowed protocol and leaves no src; render nothing rather than a
    // broken-image placeholder.
    if (typeof src !== "string" || !src) return null;
    return (
      <img
        src={src}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        className="my-2 max-h-72 max-w-full rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] object-contain"
      />
    );
  },
  input: ({ type, checked }) =>
    type === "checkbox" ? (
      <input type="checkbox" checked={Boolean(checked)} readOnly disabled className="mr-1.5 align-[-0.12em] accent-[var(--ec-accent)]" />
    ) : null,

  details: ({ children }) => (
    <details className="my-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 py-1.5">{children}</details>
  ),
  summary: ({ children }) => <summary className="m-tap select-none py-1 font-medium">{children}</summary>,
  sub: ({ children }) => <sub className="text-[0.82em] text-[var(--ec-muted)]">{children}</sub>,
};

export const RichText = ({ children, className }: { children: string; className?: string }) => {
  if (!children.trim()) return null;

  return (
    // min-w-0 lets the scrollable code/table boxes shrink inside a flex parent (e.g. chat bubbles).
    <div className={cn("m-wrap-anywhere min-w-0 text-[13.5px]", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
};
