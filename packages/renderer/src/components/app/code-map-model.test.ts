import { describe, expect, it } from "vitest";
import {
  buildCodeMapTree,
  codeMapBreadcrumb,
  codeMapChangesFromDiff,
  formatCodeMapLines,
  hitTestCodeMap,
  layoutCodeMap,
  type CodeMapChange,
} from "./code-map-model";

const files = [
  { path: "apps/web/src/main.ts", lines: 300, imports: [1, 2] },
  { path: "apps/web/src/util.ts", lines: 100 },
  { path: "packages/shared/index.ts", lines: 500, imports: [1] },
  { path: "README.md", lines: 100 },
];
const changes: CodeMapChange[] = [
  { path: "apps/web/src/util.ts", kind: "modified", additions: 4, deletions: 1 },
  { path: "packages/shared/removed.ts", kind: "deleted", additions: 0, deletions: 40 },
];

describe("codeMapChangesFromDiff", () => {
  it("classifies added, modified, and deleted files with their line counts", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n",
      "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+hello\n",
      "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n",
    ].join("");
    expect(codeMapChangesFromDiff(diff)).toEqual([
      { path: "src/a.ts", kind: "modified", additions: 2, deletions: 1 },
      { path: "new.ts", kind: "added", additions: 1, deletions: 0 },
      { path: "gone.ts", kind: "deleted", additions: 0, deletions: 1 },
    ]);
    expect(codeMapChangesFromDiff("not a diff")).toEqual([]);
  });
});

describe("buildCodeMapTree", () => {
  it("collapses single-folder chains and aggregates sizes and change counts", () => {
    const tree = buildCodeMapTree(files, changes);
    expect(tree.root.children?.map((node) => node.name)).toEqual(["packages/shared", "apps/web/src", "README.md"]);
    expect(tree.root.fileCount).toBe(5);
    expect(tree.root.lines).toBe(1040);
    expect(tree.root.changedFiles).toBe(2);
    const web = tree.folders.get("apps/web/src")!;
    expect(web).toMatchObject({ lines: 400, changedFiles: 1, additions: 4, deletions: 1 });
    expect(tree.folders.has("apps")).toBe(false);
    expect(codeMapBreadcrumb(web).map((node) => node.path)).toEqual(["", "apps/web/src"]);
  });

  it("adds placeholders for changed files missing from the scan and indexes reverse imports", () => {
    const tree = buildCodeMapTree(files, changes);
    const removed = tree.folders.get("packages/shared")!.children!.find((node) => node.name === "removed.ts")!;
    expect(removed).toMatchObject({ fileIndex: -1, lines: 40, change: { kind: "deleted" } });
    expect(tree.fileNodes[1]!.change?.kind).toBe("modified");
    expect(tree.importedBy).toEqual([[], [0, 2], [0], []]);
  });

  it("keeps changed files visible by flooring their layout weight", () => {
    const tree = buildCodeMapTree([{ path: "big.ts", lines: 100_000 }, { path: "tiny.ts", lines: 2 }], [
      { path: "tiny.ts", kind: "modified", additions: 1, deletions: 1 },
    ]);
    expect(tree.fileNodes[1]!.weight).toBe(41);
    expect(tree.fileNodes[1]!.lines).toBe(2);
  });
});

describe("layoutCodeMap", () => {
  const tree = buildCodeMapTree(files, changes);
  const rects = layoutCodeMap(tree.root, 800, 600);

  it("tiles the whole surface without overlapping file rectangles", () => {
    const fileRects = rects.filter((rect) => !rect.node.children);
    expect(fileRects).toHaveLength(5);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(800.001);
      expect(rect.y + rect.height).toBeLessThanOrEqual(600.001);
    }
    for (const [index, left] of fileRects.entries()) {
      for (const right of fileRects.slice(index + 1)) {
        const overlapX = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
        const overlapY = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
        expect(overlapX > 0.001 && overlapY > 0.001).toBe(false);
      }
    }
  });

  it("gives larger files more area and labels folders that have room", () => {
    const area = (path: string) => {
      const rect = rects.find((entry) => entry.node.path === path)!;
      return rect.width * rect.height;
    };
    expect(area("packages/shared/index.ts")).toBeGreaterThan(area("apps/web/src/main.ts"));
    expect(area("apps/web/src/main.ts")).toBeGreaterThan(area("apps/web/src/util.ts"));
    expect(rects.find((rect) => rect.node.path === "apps/web/src")).toMatchObject({ leaf: false, headerHeight: 15 });
    expect(rects[0]).toMatchObject({ node: tree.root, headerHeight: 0 });
  });

  it("hit-tests to the deepest rectangle and lays out a zoomed folder on its own", () => {
    const util = rects.find((rect) => rect.node.path === "apps/web/src/util.ts")!;
    expect(hitTestCodeMap(rects, util.x + util.width / 2, util.y + util.height / 2)).toBe(util);
    expect(hitTestCodeMap(rects, -5, -5)).toBeNull();
    const zoomed = layoutCodeMap(tree.folders.get("apps/web/src")!, 400, 300);
    expect(zoomed.map((rect) => rect.node.name).sort()).toEqual(["apps/web/src", "main.ts", "util.ts"]);
  });

  it("draws folders too small to subdivide as a single block", () => {
    const tiny = layoutCodeMap(tree.root, 5, 5);
    expect(tiny).toHaveLength(1);
    expect(tiny[0]).toMatchObject({ leaf: true });
    expect(layoutCodeMap(tree.root, 0, 0)).toEqual([]);
  });
});

describe("formatCodeMapLines", () => {
  it("abbreviates large counts", () => {
    expect([12, 1234, 56_400, 2_300_000].map(formatCodeMapLines)).toEqual(["12", "1.2k", "56k", "2.3M"]);
  });
});
