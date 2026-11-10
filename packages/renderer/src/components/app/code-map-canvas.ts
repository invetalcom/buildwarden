import { formatCodeMapLines, type CodeMapChangeKind, type CodeMapNode, type CodeMapRect, type CodeMapTree } from "./code-map-model";

export interface CodeMapPalette {
  tile: string;
  folderStroke: string;
  text: string;
  muted: string;
  faint: string;
  added: string;
  addedSoft: string;
  modified: string;
  modifiedSoft: string;
  deleted: string;
  deletedSoft: string;
  imports: string;
  importedBy: string;
}

const FONT = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const MAX_ARCS_PER_DIRECTION = 250;
const DENSE_ARC_COUNT = 60;

/** Canvas cannot resolve CSS variables itself, so the theme tokens are read from the element. */
export const readCodeMapPalette = (element: Element): CodeMapPalette => {
  const style = getComputedStyle(element);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    // The hover tint is the one neutral surface token that contrasts with the panel in both themes.
    tile: token("--ec-hover", "rgba(128, 128, 128, 0.18)"),
    folderStroke: token("--ec-border", "rgba(128, 128, 128, 0.3)"),
    text: token("--ec-text", "#f2f5f7"),
    muted: token("--ec-muted", "#a9b3bc"),
    faint: token("--ec-faint", "#79838d"),
    added: token("--ec-success", "#3ad58a"),
    addedSoft: token("--ec-success-soft", "rgba(58, 213, 138, 0.14)"),
    modified: token("--ec-warning", "#ffd166"),
    modifiedSoft: token("--ec-warning-soft", "rgba(255, 209, 102, 0.14)"),
    deleted: token("--ec-danger", "#ff6b7a"),
    deletedSoft: token("--ec-danger-soft", "rgba(255, 107, 122, 0.14)"),
    imports: token("--ec-info", "#7fb6ff"),
    importedBy: token("--ec-success", "#3ad58a"),
  };
};

const changeColors = (palette: CodeMapPalette, kind: CodeMapChangeKind): { stroke: string; fill: string } => {
  if (kind === "added") return { stroke: palette.added, fill: palette.addedSoft };
  if (kind === "deleted") return { stroke: palette.deleted, fill: palette.deletedSoft };
  return { stroke: palette.modified, fill: palette.modifiedSoft };
};

const roundedRect = (ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) => {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, Math.max(0, Math.min(radius, width / 2, height / 2)));
};

const truncate = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  return maxChars <= 1 ? "" : `${text.slice(0, maxChars - 1)}…`;
};

/** Draws `+a −d` right-aligned and returns the width it used, or 0 when it does not fit. */
const drawLineCounts = (
  ctx: CanvasRenderingContext2D,
  palette: CodeMapPalette,
  node: CodeMapNode,
  right: number,
  baseline: number,
  available: number,
  charWidth: number,
): number => {
  if (node.changedFiles === 0) return 0;
  const additions = `+${node.additions}`;
  const deletions = `−${node.deletions}`;
  const width = (additions.length + deletions.length + 1) * charWidth;
  if (width > available) return 0;
  ctx.fillStyle = palette.deleted;
  ctx.fillText(deletions, right - deletions.length * charWidth, baseline);
  ctx.fillStyle = palette.added;
  ctx.fillText(additions, right - width, baseline);
  return width + charWidth;
};

const drawFolder = (ctx: CanvasRenderingContext2D, palette: CodeMapPalette, rect: CodeMapRect, charWidth: number) => {
  const { node, x, y, width, height } = rect;
  if (rect.leaf) {
    // Too small to subdivide: one block that still shows whether anything inside changed.
    const colors = node.changedFiles > 0 ? { stroke: palette.modified, fill: palette.modifiedSoft } : null;
    roundedRect(ctx, x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1), 2);
    ctx.fillStyle = colors?.fill ?? palette.tile;
    ctx.fill();
    if (colors) {
      ctx.strokeStyle = colors.stroke;
      ctx.stroke();
    }
    return;
  }
  roundedRect(ctx, x + 0.5, y + 0.5, width - 1, height - 1, 4);
  ctx.strokeStyle = palette.folderStroke;
  ctx.stroke();
  if (rect.headerHeight === 0) return;
  const baseline = y + 11;
  const used = drawLineCounts(ctx, palette, node, x + width - 5, baseline, width * 0.45, charWidth);
  const maxChars = Math.floor((width - 10 - used) / charWidth);
  const name = truncate(node.name, maxChars);
  ctx.fillStyle = node.changedFiles > 0 ? palette.modified : palette.muted;
  ctx.fillText(name, x + 5, baseline);
  const size = formatCodeMapLines(node.lines);
  if (name === node.name && name.length + size.length + 1 <= maxChars) {
    ctx.fillStyle = palette.faint;
    ctx.fillText(size, x + 5 + (name.length + 1) * charWidth, baseline);
  }
};

const drawFile = (ctx: CanvasRenderingContext2D, palette: CodeMapPalette, rect: CodeMapRect, charWidth: number) => {
  const { node, x, y, width, height } = rect;
  const colors = node.change ? changeColors(palette, node.change.kind) : null;
  roundedRect(ctx, x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1), 2);
  ctx.fillStyle = colors?.fill ?? palette.tile;
  ctx.fill();
  if (colors) {
    ctx.setLineDash(node.change?.kind === "deleted" ? [3, 2] : []);
    ctx.strokeStyle = colors.stroke;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (width < 34 || height < 13) return;
  const baseline = y + 11;
  const used = drawLineCounts(ctx, palette, node, x + width - 4, baseline, width * 0.5, charWidth);
  ctx.fillStyle = colors?.stroke ?? palette.text;
  ctx.fillText(truncate(node.name, Math.floor((width - 8 - used) / charWidth)), x + 4, baseline);
  if (height >= 27) {
    ctx.fillStyle = palette.faint;
    ctx.fillText(truncate(`${formatCodeMapLines(node.lines)} lines`, Math.floor((width - 8) / charWidth)), x + 4, baseline + 12);
  }
};

export const drawCodeMap = (ctx: CanvasRenderingContext2D, rects: readonly CodeMapRect[], palette: CodeMapPalette): void => {
  ctx.font = FONT;
  ctx.lineWidth = 1;
  const charWidth = ctx.measureText("0").width || 6;
  for (const rect of rects) {
    if (rect.node.children) drawFolder(ctx, palette, rect, charWidth);
    else drawFile(ctx, palette, rect, charWidth);
  }
};

export interface CodeMapHoverLinks {
  /** Files the hovered file imports that are visible in the current view. */
  imports: CodeMapRect[];
  importedBy: CodeMapRect[];
}

/** Visible rectangle standing in for a file: the file's own tile, or the collapsed folder block that contains it. */
const visibleRectFor = (node: CodeMapNode | undefined, rectByNode: ReadonlyMap<CodeMapNode, CodeMapRect>): CodeMapRect | null => {
  for (let current: CodeMapNode | null | undefined = node; current; current = current.parent) {
    const rect = rectByNode.get(current);
    if (rect) return rect.leaf ? rect : null;
  }
  return null;
};

export const codeMapHoverLinks = (
  tree: CodeMapTree,
  files: readonly { imports?: number[] }[],
  hovered: CodeMapNode,
  rectByNode: ReadonlyMap<CodeMapNode, CodeMapRect>,
): CodeMapHoverLinks => {
  const collect = (indexes: readonly number[]): CodeMapRect[] => {
    const rects = new Set<CodeMapRect>();
    for (const index of indexes) {
      const rect = visibleRectFor(tree.fileNodes[index], rectByNode);
      if (rect && rect.node !== hovered) rects.add(rect);
      if (rects.size >= MAX_ARCS_PER_DIRECTION) break;
    }
    return [...rects];
  };
  if (hovered.fileIndex < 0) return { imports: [], importedBy: [] };
  return {
    imports: collect(files[hovered.fileIndex]?.imports ?? []),
    importedBy: collect(tree.importedBy[hovered.fileIndex] ?? []),
  };
};

const center = (rect: CodeMapRect): [number, number] => [rect.x + rect.width / 2, rect.y + rect.height / 2];

const drawArcs = (ctx: CanvasRenderingContext2D, from: CodeMapRect, targets: readonly CodeMapRect[], color: string) => {
  const [startX, startY] = center(from);
  // Hub files link to hundreds of others; fainter arcs and no tile outlines keep the map legible underneath.
  const dense = targets.length > DENSE_ARC_COUNT;
  ctx.globalAlpha = dense ? 0.4 : 0.9;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  for (const target of targets) {
    const [endX, endY] = center(target);
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    // Bow each arc sideways so links to neighbours in one row do not draw over each other.
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo((startX + endX) / 2 - deltaY * 0.18, (startY + endY) / 2 + deltaX * 0.18, endX, endY);
    ctx.stroke();
    if (!dense) {
      roundedRect(ctx, target.x + 0.5, target.y + 0.5, Math.max(1, target.width - 1), Math.max(1, target.height - 1), 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(endX, endY, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
};

export const drawCodeMapHover = (
  ctx: CanvasRenderingContext2D,
  palette: CodeMapPalette,
  hovered: CodeMapRect,
  links: CodeMapHoverLinks,
): void => {
  ctx.lineWidth = 1.25;
  drawArcs(ctx, hovered, links.imports, palette.imports);
  drawArcs(ctx, hovered, links.importedBy, palette.importedBy);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = palette.text;
  roundedRect(ctx, hovered.x + 0.5, hovered.y + 0.5, Math.max(1, hovered.width - 1), Math.max(1, hovered.height - 1), hovered.node.children ? 4 : 2);
  ctx.stroke();
  if (links.imports.length + links.importedBy.length > 0) {
    const [x, y] = center(hovered);
    ctx.fillStyle = palette.text;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
};
