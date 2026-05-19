import type { MouseEvent } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/cn";

const mdComponents = (compact: boolean): Components => ({
  p: ({ children, ...props }) => (
    <p className={cn("mb-2 text-zinc-200 last:mb-0", compact ? "leading-snug" : "leading-relaxed")} {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul
      className={cn(
        "my-2 list-outside list-disc space-y-1 pl-5 text-zinc-200 marker:text-cyan-500/80",
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
        "my-2 list-outside list-decimal space-y-1 pl-5 text-zinc-200 marker:text-cyan-500/80",
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
    <strong className="font-semibold text-zinc-100" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic text-zinc-200" {...props}>
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
      if (!lower.startsWith("http://") && !lower.startsWith("https://") && !lower.startsWith("mailto:")) {
        return;
      }
      e.preventDefault();
      void window.easycode.openExternalUrl(href);
    };
    return (
      <a
        href={href}
        className="break-all text-cyan-400 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-300"
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
    <h1 className={cn("mb-2 mt-3 font-semibold text-zinc-100 first:mt-0", compact ? "text-base" : "text-lg")} {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className={cn("mb-2 mt-3 font-semibold text-zinc-100 first:mt-0", compact ? "text-[15px]" : "text-base")} {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className={cn("mb-1.5 mt-2 font-medium text-zinc-100 first:mt-0", compact ? "text-[14px]" : "text-[15px]")} {...props}>
      {children}
    </h3>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-2 border-l-2 border-cyan-500/35 bg-zinc-900/40 py-1 pl-3 text-zinc-300 [&_p]:mb-1 [&_p]:last:mb-0"
      {...props}
    >
      {children}
    </blockquote>
  ),
  hr: (props) => <hr className="my-3 border-zinc-800" {...props} />,
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={cn("font-mono text-[12px] text-zinc-200", className)} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className={cn(
          "rounded bg-zinc-800/90 px-1 py-0.5 font-mono text-[0.92em] text-cyan-100/95",
          compact ? "text-[12px]" : "text-[13px]",
        )}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre
      className={cn(
        "app-scrollbar my-2 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/90 p-2.5 font-mono text-zinc-200",
        compact ? "text-[11px] leading-relaxed" : "text-xs leading-relaxed",
      )}
      {...props}
    >
      {children}
    </pre>
  ),
  table: ({ children, ...props }) => (
    <div className="app-scrollbar my-2 max-w-full overflow-x-auto rounded-lg border border-zinc-800">
      <table className={cn("w-full border-collapse text-left text-zinc-200", compact ? "text-[11px]" : "text-xs")} {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => <thead className="border-b border-zinc-700 bg-zinc-900/80" {...props}>{children}</thead>,
  tbody: ({ children, ...props }) => <tbody className="divide-y divide-zinc-800/80" {...props}>{children}</tbody>,
  tr: ({ children, ...props }) => <tr {...props}>{children}</tr>,
  th: ({ children, ...props }) => (
    <th className="px-2 py-1.5 font-medium text-zinc-100" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="px-2 py-1.5 text-zinc-300" {...props}>
      {children}
    </td>
  ),
});

export interface ActivityRichTextProps {
  content: string;
  /** Tighter typography for compact run activity panel */
  compact?: boolean;
  className?: string;
}

/**
 * Renders agent/user messages as Markdown (lists, code, tables via GFM).
 * Do not pass git diffs here — handle those separately.
 */
export const ActivityRichText = ({ content, compact = false, className }: ActivityRichTextProps) => {
  if (!content.trim()) {
    return null;
  }

  return (
    <div className={cn(compact ? "text-[13px]" : "text-sm", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents(compact)}>
        {content}
      </ReactMarkdown>
    </div>
  );
};
