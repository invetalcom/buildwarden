export interface ResponseCitation {
  stepId: string;
  text: string;
  kind: "reply" | "cite";
}

const SOURCE_PREFIX = "#buildwarden-response-";

export const responseCitationHref = (stepId: string): string => SOURCE_PREFIX + encodeURIComponent(stepId)
  .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

export const responseCitationStepId = (href: string | undefined): string | null => {
  if (!href?.startsWith(SOURCE_PREFIX)) return null;
  try { return decodeURIComponent(href.slice(SOURCE_PREFIX.length)) || null; }
  catch { return null; }
};

/** Ordinary prompt Markdown keeps the snapshot in drafts, queues, history and every provider's input. */
export const appendResponseCitation = (prompt: string, citation: ResponseCitation): string => {
  // Selections are rendered plain text, whereas replies retain the response's source Markdown.
  const text = citation.kind === "cite"
    ? citation.text.replace(/&/g, "&amp;").replace(/[\\`*_[\]{}()#+.!<>|:~-]/g, "\\$&")
    : citation.text;
  const label = citation.kind === "reply" ? "Reply to assistant response" : "Cited assistant response";
  const quote = text.trim().split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  return `${prompt.trimEnd()}${prompt.trim() ? "\n\n" : ""}[${label}](${responseCitationHref(citation.stepId)})\n\n${quote}\n\n`;
};

export const selectedResponseText = (element: HTMLElement | null, selection: Selection | null): string => {
  if (!element || !selection || selection.isCollapsed || selection.rangeCount !== 1) return "";
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return "";
  return selection.toString().trim();
};

/** Only assistant content is marked; selections spanning other activity cannot become citations. */
export const selectedResponseCitation = (container: HTMLElement, selection: Selection | null): ResponseCitation | null => {
  if (!selection || selection.rangeCount !== 1) return null;
  const start = selection.getRangeAt(0).startContainer;
  const element = start instanceof Element ? start : start.parentElement;
  const content = element?.closest<HTMLElement>("[data-response-content-id]");
  if (!content || !container.contains(content)) return null;
  const text = selectedResponseText(content, selection);
  const stepId = content.dataset.responseContentId;
  return text && stepId ? { kind: "cite", stepId, text } : null;
};

export const revealRenderedResponse = (container: HTMLElement | null, stepId: string): boolean => {
  const source = Array.from(container?.querySelectorAll<HTMLElement>("[data-response-id]") ?? [])
    .find((element) => element.dataset.responseId === stepId);
  if (!source) return false;
  source.scrollIntoView({ block: "center" });
  return true;
};
