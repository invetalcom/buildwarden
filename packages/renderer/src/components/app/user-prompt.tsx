import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DesignPromptDetailItem, StoredChatAttachment } from "@buildwarden/shared";
import { usePromptStyle } from "../../lib/prompt-style";
import { Button } from "../ui/button";
import { PromptFiles } from "./prompt-files";
import { StoredChatAttachments } from "./StoredChatAttachments";
import "./user-prompt.css";

/** A small icon button in the line under a prompt. */
export const PromptAction = ({ label, title, disabled, onClick, children }: {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Button
    type="button"
    variant="ghost"
    size="sm"
    className="h-5 w-5 shrink-0 p-0 text-[color:var(--ec-muted)] hover:bg-[color:var(--ec-hover)] hover:text-[color:var(--ec-text)]"
    title={title ?? label}
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </Button>
);

/** The text of a prompt. A theme may limit its lines; a longer prompt then opens on "Show more". */
const PromptText = ({ clampLines, children }: { clampLines: number; children: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const clamped = clampLines > 0 && !expanded;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !clamped || typeof ResizeObserver !== "function") return;
    // Fires once when it starts observing, and again when the bubble or its text changes size.
    const observer = new ResizeObserver(() => setOverflows(element.scrollHeight > element.clientHeight + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, [clamped, clampLines]);

  return (
    <>
      <div ref={ref} className="user-prompt-text" data-clamped={clamped ? (overflows ? "cut" : "fits") : undefined}>{children}</div>
      {clampLines > 0 && (overflows || expanded) ? (
        <button type="button" className="user-prompt-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
};

/**
 * A prompt you sent, in a run or a chat: its files, a bubble that hugs the text, and a line of
 * details under it. The look comes from the theme's prompt options (`DesignPrompt`): most of them
 * reach the page as CSS variables, and the ones that change the markup are read here.
 */
export const UserPrompt = ({ text, attachments, fallbackNames, kind = null, mode, time, actions, compact = false }: {
  /** The rendered text, or null for a prompt that only carries files. */
  text: ReactNode;
  attachments: StoredChatAttachment[];
  /** Names of files whose data was not kept. */
  fallbackNames: readonly string[];
  kind?: "follow-up" | "steered" | null;
  /** The mode the prompt ran in. Chats have none. */
  mode?: ReactNode;
  time: string;
  /** Buttons at the end of the details line. */
  actions: ReactNode;
  compact?: boolean;
}) => {
  const style = usePromptStyle();
  const files = <PromptFiles attachments={attachments} fallbackNames={fallbackNames} layout={style.files} max={style.filesMax} labels={style.thumbnailLabels} />;
  const details: Record<DesignPromptDetailItem, ReactNode> = {
    kind: kind ? <span key="kind" className="user-prompt-kind" title={kind === "steered" ? "Sent into the running turn" : undefined}>{kind}</span> : null,
    mode: mode ? <Fragment key="mode">{mode}</Fragment> : null,
    time: <span key="time" className="tabular-nums">{time}</span>,
  };

  return (
    <div className="user-prompt" data-ui="message-user-row">
      {style.files === "above" ? files : null}
      <div className="user-prompt-bubble" data-ui="message-user">
        {text === null || text === undefined || text === false ? null : <PromptText clampLines={style.clampLines}>{text}</PromptText>}
        {style.files === "above" ? null : files}
        <StoredChatAttachments attachments={attachments} only="annotations" compact={compact} />
      </div>
      <div className="user-prompt-details" data-ui="message-user-details">
        {style.detailItems.map((item) => details[item])}
        <span className="user-prompt-actions">{actions}</span>
      </div>
    </div>
  );
};
