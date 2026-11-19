type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };

const ALERT_TITLES: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};
const MARKER = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

const firstElement = (nodes: Node[] = []) => nodes.find((node) => node.type === "element");

const toAlert = (blockquote: Node): void => {
  const paragraph = firstElement(blockquote.children);
  const text = paragraph?.tagName === "p" ? paragraph.children?.[0] : undefined;
  const match = text?.type === "text" ? MARKER.exec(text.value ?? "") : null;
  if (!paragraph || !text || !match) return;
  const kind = match[1].toLowerCase();
  text.value = (text.value ?? "").slice(match[0].length);
  // A marker on its own line followed by `<br>` or nothing leaves an empty paragraph behind.
  while (paragraph.children?.[0] && (paragraph.children[0].tagName === "br" || (paragraph.children[0].type === "text" && !paragraph.children[0].value?.trim()))) {
    paragraph.children.shift();
  }
  const body = (blockquote.children ?? []).filter((node) => node !== paragraph || Boolean(paragraph.children?.length));
  blockquote.tagName = "div";
  blockquote.properties = { className: ["response-alert", `response-alert-${kind}`], role: "note" };
  blockquote.children = [
    // A div: the platform paragraph components replace class names.
    { type: "element", tagName: "div", properties: { className: ["response-alert-title"] }, children: [{ type: "text", value: ALERT_TITLES[kind] }] },
    ...body,
  ];
};

/**
 * GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`).
 * Applied AFTER sanitization: it only adds fixed class names and a fixed title.
 */
export const responseAlerts = () => (tree: Node): void => {
  const visit = (node: Node) => {
    if (["pre", "code"].includes(node.tagName ?? "")) return;
    node.children?.forEach(visit);
    if (node.tagName === "blockquote") toAlert(node);
  };
  visit(tree);
};
