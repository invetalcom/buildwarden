export type ToolResultImage = { mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

const omitBinaryContent = (_key: string, value: unknown): unknown => {
  if (!record(value)) return value;
  const mimeType = value.mimeType ?? value.media_type;
  const mediaMimeType = typeof mimeType === "string" && /^(image|audio)\//i.test(mimeType.trim());
  if (value.type === "image" || value.type === "audio" || mediaMimeType) {
    return {
      ...value,
      ...(typeof value.data === "string" ? { data: "[data omitted]" } : {}),
      ...(record(value.source) && typeof value.source.data === "string"
        ? { source: { ...value.source, data: "[data omitted]" } } : {}),
    };
  }
  if (typeof value.uri === "string" && typeof value.blob === "string") {
    return { ...value, blob: "[blob omitted]" };
  }
  return value;
};

/** Bounded, provider-neutral content persisted in the existing step metadata JSON. */
export const presentToolResult = (value: unknown): { text: string; images: ToolResultImage[] } => {
  const images: ToolResultImage[] = [];
  const texts: string[] = [];
  const visit = (entry: unknown, depth: number): void => {
    if (depth > 8 || entry == null) return;
    if (typeof entry === "string") { texts.push(entry.slice(0, 64000)); return; }
    if (Array.isArray(entry)) { entry.slice(0, 100).forEach((item) => visit(item, depth + 1)); return; }
    if (!record(entry)) { texts.push(String(entry)); return; }
    if (entry.type === "image") {
      const source = record(entry.source) ? entry.source : entry;
      const mimeType = source.mimeType ?? source.media_type;
      if ((mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp") && typeof source.data === "string" && source.data.length <= 3_000_000 && /^[A-Za-z0-9+/=\r\n]+$/.test(source.data) && images.length < 4) images.push({ mimeType, data: source.data });
      texts.push("[Image]");
    } else if (typeof entry.text === "string") visit(entry.text, depth + 1);
    else if (entry.content !== undefined && (!Array.isArray(entry.content) || entry.content.length > 0)) visit(entry.content, depth + 1);
    else if (entry.structuredContent !== undefined) visit(entry.structuredContent, depth + 1);
    else texts.push(JSON.stringify(entry, omitBinaryContent, 2).slice(0, 64000));
  };
  visit(value, 0);
  return { text: texts.join("\n").slice(0, 64000), images };
};

export const toolPresentation = (name: string, args: unknown, server?: string): Record<string, unknown> => {
  const mcp = name.startsWith("mcp__") || Boolean(server) || name.startsWith("buildwarden_");
  if (!mcp) return {};
  const input = record(args) ? args : {};
  const shortName = name.split("__").at(-1) ?? name;
  const title = shortName === "buildwarden_browser"
    ? `Browser · ${typeof input.action === "string" ? input.action : "action"}`
    : /^(?:(?:cua_repl|node_repl)\.)?js$/.test(shortName) && typeof input.title === "string" ? input.title.slice(0, 200) : undefined;
  const toolServer = server ?? name.split("__")[1] ?? "BuildWarden";
  return { isMcpTool: true, toolServer, toolDisplayTitle: title ?? `${toolServer} · ${shortName.replaceAll("_", " ")}`, arguments: input };
};
