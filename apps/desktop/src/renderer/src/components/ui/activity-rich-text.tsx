import type { MouseEvent } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { FileText } from "lucide-react";
import { isExternalRunWorkspaceHref, parseRunWorkspaceFileReference } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { getOpenableInlineCodePath } from "./activity-file-links";
import { Button } from "./button";

const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), "details", "summary", "sub", "img", "input", "br"])],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "href", "title"],
    details: ["open"],
    img: ["src", "alt", "title", "width", "height"],
    input: ["type", "checked", "disabled"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https"],
  },
};

const mdComponents = (compact: boolean, onOpenWorkspaceFile?: (path: string) => void): Components => ({
  p: ({ children, ...props }) => (
    <p className={cn("mb-2 text-[color:var(--ec-text)] last:mb-0", compact ? "leading-snug" : "leading-relaxed")} {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul
      className={cn(
        "my-2 list-outside list-disc space-y-1 pl-5 text-[color:var(--ec-text)] marker:text-[color:var(--ec-accent)]",
        compact ? "text-[13px] leading-snug" : "text-sm leading-relaxed",
      )}
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol
      className={cn(
        "my-2 list-outside list-decimal space-y-1 pl-5 text-[color:var(--ec-text)] marker:text-[color:var(--ec-accent)]",
        compact ? "text-[13px] leading-snug" : "text-sm leading-relaxed",
      )}
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="pl-0.5 [&>p]:mb-1 [&>p]:last:mb-0" {...props}>
      {children}
    </li>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-[color:var(--ec-text)]" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic text-[color:var(--ec-text)]" {...props}>
      {children}
    </em>
  ),
  a: ({ children, href, onClick, ...props }) => {
    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented) {
        return;
      }
      if (!href) {
        return;
      }
      const lower = href.trim().toLowerCase();
      if (!isExternalRunWorkspaceHref(lower)) {
        if (onOpenWorkspaceFile && parseRunWorkspaceFileReference(href)) {
          e.preventDefault();
          onOpenWorkspaceFile(href);
        }
        return;
      }
      e.preventDefault();
      void window.buildwarden.openExternalUrl(href);
    };
    return (
      <a
        href={href}
        className="break-all text-[color:var(--ec-accent)] underline decoration-[color:var(--ec-accent-ring)] underline-offset-2 hover:text-[color:var(--ec-accent-strong)]"
        target="_blank"
        rel="noopener noreferrer"
        {...props}
        onClick={handleClick}
      >
        {children}
      </a>
    );
  },
  h1: ({ children, ...props }) => (
    <h1 className={cn("mb-2 mt-3 font-semibold text-[color:var(--ec-text)] first:mt-0", compact ? "text-base" : "text-lg")} {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className={cn("mb-2 mt-3 font-semibold text-[color:var(--ec-text)] first:mt-0", compact ? "text-[15px]" : "text-base")} {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className={cn("mb-1.5 mt-2 font-medium text-[color:var(--ec-text)] first:mt-0", compact ? "text-[14px]" : "text-[15px]")} {...props}>
      {children}
    </h3>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-2 border-l-2 border-[color:var(--ec-border-strong)] bg-[color:var(--ec-panel-soft)] py-1 pl-3 text-[color:var(--ec-muted)] [&_p]:mb-1 [&_p]:last:mb-0"
      {...props}
    >
      {children}
    </blockquote>
  ),
  details: ({ children, ...props }) => (
    <details
      className="my-2 rounded-md border border-[color:var(--ec-border)] bg-[color:var(--ec-panel-soft)] px-2 py-1.5 text-[color:var(--ec-text)]"
      {...props}
    >
      {children}
    </details>
  ),
  summary: ({ children, ...props }) => (
    <summary
      className="cursor-pointer select-none list-inside rounded px-1 py-1 font-semibold text-[color:var(--ec-text)] hover:bg-[color:var(--ec-hover)]"
      {...props}
    >
      {children}
    </summary>
  ),
  sub: ({ children, ...props }) => (
    <sub className="text-[0.82em] leading-normal text-[color:var(--ec-muted)]" {...props}>
      {children}
    </sub>
  ),
  br: (props) => <br {...props} />,
  hr: (props) => <hr className="my-3 border-[color:var(--ec-border)]" {...props} />,
  img: ({ src, alt, title, ...props }) => {
    const href = typeof src === "string" ? src : "";
    const openImage = (event: MouseEvent<HTMLImageElement>) => {
      if (!href || (!href.startsWith("http://") && !href.startsWith("https://"))) {
        return;
      }
      event.preventDefault();
      void window.buildwarden.openExternalUrl(href);
    };
    return (
      <img
        src={href}
        alt={alt ?? ""}
        title={title}
        className="my-2 max-h-80 max-w-full cursor-zoom-in rounded-md border border-[color:var(--ec-border)] bg-[color:var(--ec-input)] object-contain"
        loading="lazy"
        {...props}
        onClick={openImage}
      />
    );
  },
  input: ({ type, checked, ...props }) => {
    if (type !== "checkbox") {
      return null;
    }
    return (
      <input
        type="checkbox"
        checked={Boolean(checked)}
        readOnly
        disabled
        className="mr-1.5 align-[-0.12em] accent-[color:var(--ec-accent)]"
        {...props}
      />
    );
  },
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={cn("font-mono text-[12px] text-[color:var(--ec-text)]", className)} {...props}>
          {children}
        </code>
      );
    }
    const openablePath = onOpenWorkspaceFile ? getOpenableInlineCodePath(children) : null;
    const inlineCode = (
      <code
        className={cn(
          "rounded bg-[color:var(--ec-control)] px-1 py-0.5 font-mono text-[0.92em] text-[color:var(--ec-text)]",
          compact ? "text-[12px]" : "text-[13px]",
        )}
        {...props}
      >
        {children}
      </code>
    );

    if (!openablePath) {
      return inlineCode;
    }

    const openInlineFile = (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onOpenWorkspaceFile?.(openablePath);
    };

    return (
      <>
        {inlineCode}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-1 h-4 w-4 rounded align-[-0.18em] p-0 text-[color:var(--ec-muted)] opacity-75 transition hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-accent)] hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--ec-accent-ring)]"
          title={`Open ${openablePath}`}
          aria-label={`Open file ${openablePath}`}
          onClick={openInlineFile}
        >
          <FileText className="h-3 w-3" aria-hidden="true" />
        </Button>
      </>
    );
  },
  pre: ({ children, ...props }) => (
    <pre
      className={cn(
        "app-scrollbar my-2 overflow-x-auto rounded-lg border border-[color:var(--ec-border)] bg-[color:var(--ec-input)] p-2.5 font-mono text-[color:var(--ec-text)]",
        compact ? "text-[11px] leading-relaxed" : "text-xs leading-relaxed",
      )}
      {...props}
    >
      {children}
    </pre>
  ),
  table: ({ children, ...props }) => (
    <div className="app-scrollbar my-2 max-w-full overflow-x-auto rounded-lg border border-[color:var(--ec-border)]">
      <table className={cn("w-full border-collapse text-left text-[color:var(--ec-text)]", compact ? "text-[11px]" : "text-xs")} {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => <thead className="border-b border-[color:var(--ec-border)] bg-[color:var(--ec-panel-soft)]" {...props}>{children}</thead>,
  tbody: ({ children, ...props }) => <tbody className="divide-y divide-[color:var(--ec-border)]" {...props}>{children}</tbody>,
  tr: ({ children, ...props }) => <tr {...props}>{children}</tr>,
  th: ({ children, ...props }) => (
    <th className="px-2 py-1.5 font-medium text-[color:var(--ec-text)]" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="px-2 py-1.5 text-[color:var(--ec-muted)]" {...props}>
      {children}
    </td>
  ),
});

export interface ActivityRichTextProps {
  content: string;
  /** Tighter typography for compact run activity panel */
  compact?: boolean;
  className?: string;
  onOpenWorkspaceFile?: (path: string) => void;
}

/**
 * Renders agent/user messages as Markdown (lists, code, tables via GFM).
 * Do not pass git diffs here — handle those separately.
 */
export const ActivityRichText = ({ content, compact = false, className, onOpenWorkspaceFile }: ActivityRichTextProps) => {
  if (!content.trim()) {
    return null;
  }

  return (
    <div className={cn(compact ? "text-[13px]" : "text-sm", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]]}
        components={mdComponents(compact, onOpenWorkspaceFile)}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
