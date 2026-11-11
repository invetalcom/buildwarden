import type { WorkspaceCodeMapFile } from "@buildwarden/shared";
import { normalizeDiffPathSegment, parseGitDiffFiles } from "./git-diff-utils";

export type CodeMapChangeKind = "added" | "modified" | "deleted";

export interface CodeMapChange {
  path: string;
  kind: CodeMapChangeKind;
  additions: number;
  deletions: number;
}

/** A folder (`children` set) or a file (`children` null) of the code map. */
export interface CodeMapNode {
  name: string;
  path: string;
  parent: CodeMapNode | null;
  children: CodeMapNode[] | null;
  lines: number;
  /** Layout weight: lines, floored so empty and changed files stay visible. */
  weight: number;
  /** Index into the scanned files; -1 for folders and for changed files the scan does not contain. */
  fileIndex: number;
  change: CodeMapChange | null;
  fileCount: number;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface CodeMapTree {
  root: CodeMapNode;
  /** File nodes by scanned-file index. */
  fileNodes: CodeMapNode[];
  /** Reverse import edges by scanned-file index. */
  importedBy: number[][];
  folders: Map<string, CodeMapNode>;
}

export interface CodeMapRect {
  node: CodeMapNode;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Height of the folder label strip; 0 for files and folders too small for one. */
  headerHeight: number;
  /** True for files and for folders drawn as one block because they are too small to subdivide. */
  leaf: boolean;
}

const CHANGED_MIN_WEIGHT = 24;
/** Changed files get at least this share of the whole map so they stay visible and clickable. */
const CHANGED_MIN_SHARE = 1 / 2500;
const HEADER_HEIGHT = 15;
const FOLDER_PADDING = 3;
const MIN_HEADER_WIDTH = 46;
const MIN_HEADER_HEIGHT = 30;
const MIN_SPLIT_SIZE = 6;

const sumHunks = (file: ReturnType<typeof parseGitDiffFiles>[number], key: "additionLines" | "deletionLines"): number =>
  file.hunks.reduce((count, hunk) => count + hunk[key], 0);

/** Changed files of a unified diff, merged by path. Unparseable input yields no changes. */
export const codeMapChangesFromDiff = (diffText: string): CodeMapChange[] => {
  const byPath = new Map<string, CodeMapChange>();
  try {
    for (const file of parseGitDiffFiles(diffText)) {
      const path = normalizeDiffPathSegment(file.name ?? "");
      if (!path) continue;
      let kind: CodeMapChangeKind = "modified";
      if (file.type === "new") kind = "added";
      else if (file.type === "deleted") kind = "deleted";
      const existing = byPath.get(path);
      if (existing) {
        existing.additions += sumHunks(file, "additionLines");
        existing.deletions += sumHunks(file, "deletionLines");
      } else {
        byPath.set(path, { path, kind, additions: sumHunks(file, "additionLines"), deletions: sumHunks(file, "deletionLines") });
      }
    }
  } catch {
    return [];
  }
  return [...byPath.values()];
};

const createNode = (name: string, path: string, parent: CodeMapNode | null, isFolder: boolean): CodeMapNode => ({
  name,
  path,
  parent,
  children: isFolder ? [] : null,
  lines: 0,
  weight: 0,
  fileIndex: -1,
  change: null,
  fileCount: 0,
  changedFiles: 0,
  additions: 0,
  deletions: 0,
});

/** Merges `a/b/c` chains of single-folder folders into one node, the way file trees usually display them. */
const collapseFolderChain = (node: CodeMapNode): void => {
  while (node.parent && node.children?.length === 1 && node.children[0]!.children) {
    const only = node.children[0]!;
    node.name = `${node.name}/${only.name}`;
    node.path = only.path;
    node.children = only.children;
    for (const child of node.children ?? []) child.parent = node;
  }
};

const finalizeNode = (node: CodeMapNode, changedFloor: number): void => {
  if (!node.children) {
    node.fileCount = 1;
    node.weight = Math.max(node.lines, 1);
    if (node.change) {
      node.changedFiles = 1;
      node.additions = node.change.additions;
      node.deletions = node.change.deletions;
      node.weight = Math.max(node.lines, changedFloor);
    }
    return;
  }
  collapseFolderChain(node);
  for (const child of node.children) {
    finalizeNode(child, changedFloor);
    node.lines += child.lines;
    node.weight += child.weight;
    node.fileCount += child.fileCount;
    node.changedFiles += child.changedFiles;
    node.additions += child.additions;
    node.deletions += child.deletions;
  }
  node.children.sort((left, right) => right.weight - left.weight || (left.name < right.name ? -1 : 1));
};

/**
 * Folder tree of the scanned files with the diff overlaid. Changed files the scan does not contain
 * (deleted, or absent from the scanned checkout) get a placeholder sized by their changed lines.
 */
export const buildCodeMapTree = (files: readonly WorkspaceCodeMapFile[], changes: readonly CodeMapChange[]): CodeMapTree => {
  const root = createNode("", "", null, true);
  const folders = new Map<string, CodeMapNode>([["", root]]);
  const filesByPath = new Map<string, CodeMapNode>();
  const insertFile = (path: string): CodeMapNode => {
    const segments = path.split("/");
    let folder = root;
    let folderPath = "";
    for (const segment of segments.slice(0, -1)) {
      folderPath = folderPath ? `${folderPath}/${segment}` : segment;
      let next = folders.get(folderPath);
      if (!next) {
        next = createNode(segment, folderPath, folder, true);
        folders.set(folderPath, next);
        folder.children!.push(next);
      }
      folder = next;
    }
    const node = createNode(segments[segments.length - 1]!, path, folder, false);
    folder.children!.push(node);
    filesByPath.set(path, node);
    return node;
  };

  const fileNodes = files.map((file, index) => {
    const node = insertFile(file.path);
    node.lines = file.lines;
    node.fileIndex = index;
    return node;
  });
  for (const change of changes) {
    let node = filesByPath.get(change.path);
    if (!node && !folders.has(change.path)) {
      node = insertFile(change.path);
      node.lines = Math.max(change.additions, change.deletions, 1);
    }
    if (node) node.change = change;
  }

  const totalLines = fileNodes.reduce((sum, node) => sum + node.lines, 0);
  finalizeNode(root, Math.max(CHANGED_MIN_WEIGHT, Math.ceil(totalLines * CHANGED_MIN_SHARE)));
  // Collapsing renames folder paths, so the lookup is rebuilt from the final tree.
  folders.clear();
  const indexFolders = (node: CodeMapNode) => {
    if (!node.children) return;
    folders.set(node.path, node);
    node.children.forEach(indexFolders);
  };
  indexFolders(root);

  const importedBy: number[][] = files.map(() => []);
  files.forEach((file, index) => {
    for (const target of file.imports ?? []) importedBy[target]?.push(index);
  });
  return { root, fileNodes, importedBy, folders };
};

/** Squarified treemap (Bruls et al.): fills the rectangle row by row, keeping tiles close to square. */
const squarify = (
  items: readonly CodeMapNode[],
  x: number,
  y: number,
  width: number,
  height: number,
  place: (item: CodeMapNode, x: number, y: number, width: number, height: number) => void,
): void => {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0 || width <= 0 || height <= 0) return;
  const scale = (width * height) / total;
  let start = 0;
  while (start < items.length) {
    const short = Math.min(width, height);
    let end = start;
    let rowArea = 0;
    let smallest = Infinity;
    let largest = 0;
    let bestRatio = Infinity;
    while (end < items.length) {
      const area = items[end]!.weight * scale;
      const nextArea = rowArea + area;
      const nextSmallest = Math.min(smallest, area);
      const nextLargest = Math.max(largest, area);
      const ratio = Math.max((short * short * nextLargest) / (nextArea * nextArea), (nextArea * nextArea) / (short * short * nextSmallest));
      if (end > start && ratio > bestRatio) break;
      rowArea = nextArea;
      smallest = nextSmallest;
      largest = nextLargest;
      bestRatio = ratio;
      end += 1;
    }
    const thickness = rowArea / short;
    let offset = 0;
    for (let index = start; index < end; index += 1) {
      const length = (items[index]!.weight * scale) / thickness;
      if (width >= height) place(items[index]!, x, y + offset, thickness, length);
      else place(items[index]!, x + offset, y, length, thickness);
      offset += length;
    }
    if (width >= height) {
      x += thickness;
      width -= thickness;
    } else {
      y += thickness;
      height -= thickness;
    }
    start = end;
  }
};

/** Rectangles in paint order: every folder precedes its contents. */
export const layoutCodeMap = (root: CodeMapNode, width: number, height: number): CodeMapRect[] => {
  const rects: CodeMapRect[] = [];
  const place = (node: CodeMapNode, x: number, y: number, w: number, h: number) => {
    const rect: CodeMapRect = { node, x, y, width: w, height: h, headerHeight: 0, leaf: true };
    rects.push(rect);
    if (!node.children || node.children.length === 0 || w < MIN_SPLIT_SIZE || h < MIN_SPLIT_SIZE) return;
    const isRoot = node === root;
    const padding = isRoot ? 0 : Math.min(FOLDER_PADDING, Math.floor(Math.min(w, h) / 6));
    const header = !isRoot && w >= MIN_HEADER_WIDTH && h >= MIN_HEADER_HEIGHT ? HEADER_HEIGHT : 0;
    const innerWidth = w - padding * 2;
    const innerHeight = h - (header || padding) - padding;
    if (innerWidth < 2 || innerHeight < 2) return;
    rect.leaf = false;
    rect.headerHeight = header;
    squarify(node.children, x + padding, y + (header || padding), innerWidth, innerHeight, place);
  };
  if (width > 0 && height > 0) place(root, 0, 0, width, height);
  return rects;
};

/** Deepest rectangle under a point; paint order guarantees later matches are nested deeper. */
export const hitTestCodeMap = (rects: readonly CodeMapRect[], x: number, y: number): CodeMapRect | null => {
  let hit: CodeMapRect | null = null;
  for (const rect of rects) {
    if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) hit = rect;
  }
  return hit;
};

export const formatCodeMapLines = (lines: number): string => {
  if (lines < 1000) return String(lines);
  if (lines < 10_000) return `${(lines / 1000).toFixed(1)}k`;
  if (lines < 1_000_000) return `${Math.round(lines / 1000)}k`;
  return `${(lines / 1_000_000).toFixed(1)}M`;
};

/** The node's ancestors from the map root down to the node itself. */
export const codeMapBreadcrumb = (node: CodeMapNode): CodeMapNode[] => {
  const trail: CodeMapNode[] = [];
  for (let current: CodeMapNode | null = node; current; current = current.parent) trail.unshift(current);
  return trail;
};
