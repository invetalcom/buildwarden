import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractImportSpecifiers, resolveCodeMapImports, scanWorkspaceCodeMap } from "./workspace-code-map";

// Lets a test change the workspace between two filesystem calls of the scan, the way an agent editing it would.
type FsHook = ((path: string) => void) | null;
const fsHooks = vi.hoisted(() => ({ afterReaddir: null as FsHook, afterLstat: null as FsHook, afterHandleStat: null as FsHook }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = async (...args: unknown[]) => {
    const entries = await (actual.readdir as (...input: unknown[]) => Promise<unknown>)(...args);
    fsHooks.afterReaddir?.(resolve(String(args[0])));
    return entries;
  };
  const lstat = async (...args: unknown[]) => {
    const stats = await (actual.lstat as (...input: unknown[]) => Promise<unknown>)(...args);
    fsHooks.afterLstat?.(resolve(String(args[0])));
    return stats;
  };
  const open = async (...args: unknown[]) => {
    const handle = await (actual.open as (...input: unknown[]) => Promise<import("node:fs/promises").FileHandle>)(...args);
    const stat = handle.stat.bind(handle) as (...input: unknown[]) => Promise<unknown>;
    Object.assign(handle, {
      stat: async (...statArgs: unknown[]) => {
        const stats = await stat(...statArgs);
        fsHooks.afterHandleStat?.(resolve(String(args[0])));
        return stats;
      },
    });
    return handle;
  };
  return { ...actual, readdir, lstat, open };
});

const scanned = (entries: Record<string, string[]>) =>
  Object.entries(entries).map(([path, specifiers]) => ({ path, lines: 1, specifiers }));
const importsOf = (files: ReturnType<typeof resolveCodeMapImports>, path: string) =>
  (files.find((file) => file.path === path)?.imports ?? []).map((index) => files[index]!.path);

describe("extractImportSpecifiers", () => {
  it("finds static, re-export, side-effect, dynamic, and CommonJS imports", () => {
    const source = [
      "import a, { b as c, type D } from './a';",
      "import * as ns from \"./ns\";",
      "import {\n  multi,\n  line,\n} from './multi';",
      "import './side-effect.css';",
      "export * from './star';",
      "export { x } from './named';",
      "const lazy = () => import('./lazy');",
      "const legacy = require('./legacy');",
    ].join("\n");
    expect(extractImportSpecifiers(source).sort()).toEqual(
      ["./a", "./lazy", "./legacy", "./multi", "./named", "./ns", "./side-effect.css", "./star"],
    );
  });

  it("ignores exports, member calls, and strings that only look like imports", () => {
    const source = [
      "export const from = 'not-a-module';",
      "export default 'value';",
      "loader.import('./member');",
      "const text = reimport('./prefixed');",
    ].join("\n");
    expect(extractImportSpecifiers(source)).toEqual([]);
  });

  it("does not read an import clause across the next import or export keyword", () => {
    const source = "export { a, b }\nimport c from './c';\nexport const from = 1;\nimport './d';";
    expect(extractImportSpecifiers(source).sort()).toEqual(["./c", "./d"]);
  });

  it("stays fast on long whitespace runs and repeated keywords", () => {
    const hostile = [
      `import${" ".repeat(50_000)}`,
      `export${"\n".repeat(50_000)}from`,
      "export ".repeat(50_000),
      "import {a,\n".repeat(40_000),
      `import(${" ".repeat(50_000)}`,
    ];
    const started = performance.now();
    for (const source of hostile) expect(extractImportSpecifiers(source)).toEqual([]);
    // Linear matching needs a few milliseconds here; the backtracking it replaces needed minutes.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("resolveCodeMapImports", () => {
  it("resolves relative imports by extension, index file, and emitted .js name", () => {
    const files = resolveCodeMapImports(scanned({
      "src/app.ts": ["./util", "./widgets", "./esm.js", "../outside-root/../../escape", "react"],
      "src/esm.ts": [],
      "src/util.tsx": [],
      "src/widgets/index.ts": [],
    }), new Map());
    expect(importsOf(files, "src/app.ts")).toEqual(["src/esm.ts", "src/util.tsx", "src/widgets/index.ts"]);
  });

  it("resolves workspace packages and tsconfig path aliases, preferring the nearest config", () => {
    const configs = new Map([
      ["packages/shared/package.json", JSON.stringify({ name: "@acme/shared", main: "./dist/index.js" })],
      ["apps/web/tsconfig.json", "{\n  // comments and trailing commas are fine\n  \"compilerOptions\": { \"paths\": { \"@/*\": [\"./src/*\"], }, },\n}"],
      ["tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./wrong/*"] } } })],
    ]);
    const files = resolveCodeMapImports(scanned({
      "apps/web/src/main.ts": ["@/lib/format", "@acme/shared", "@acme/shared/extra", "packages/shared/src/index"],
      "apps/web/src/lib/format.ts": [],
      "packages/shared/src/extra.ts": [],
      "packages/shared/src/index.ts": [],
      "wrong/lib/format.ts": [],
    }), configs);
    expect(importsOf(files, "apps/web/src/main.ts")).toEqual([
      "apps/web/src/lib/format.ts",
      "packages/shared/src/extra.ts",
      "packages/shared/src/index.ts",
    ]);
  });

  it("omits self-imports and leaves files without workspace imports edge-free", () => {
    const files = resolveCodeMapImports(scanned({ "a.ts": ["./a", "left-pad"] }), new Map());
    expect(files).toEqual([{ path: "a.ts", lines: 1 }]);
  });
});

describe("scanWorkspaceCodeMap", () => {
  let root = "";
  let outside = "";
  afterEach(() => {
    fsHooks.afterReaddir = null;
    fsHooks.afterLstat = null;
    fsHooks.afterHandleStat = null;
    for (const dir of [root, outside]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    root = "";
    outside = "";
  });
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  it("maps text files of a plain folder with line counts and import edges", async () => {
    root = mkdtempSync(join(tmpdir(), "buildwarden-code-map-"));
    write("src/main.ts", "import { helper } from './helper';\nhelper();\n");
    write("src/helper.ts", "export const helper = () => 1;");
    write("README.md", "one\ntwo\nthree\n");
    write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    write("data.txt", Buffer.from([0x61, 0x00, 0x62]));
    write("pnpm-lock.yaml", "lockfileVersion: 9\n");
    write("node_modules/dep/index.js", "module.exports = 1;\n");

    const result = await scanWorkspaceCodeMap(root);
    expect(result.truncated).toBe(false);
    expect(result.workspaceUnavailable).toBe(false);
    expect(result.files).toEqual([
      { path: "README.md", lines: 3 },
      { path: "src/helper.ts", lines: 1 },
      { path: "src/main.ts", lines: 2, imports: [1] },
    ]);
  });

  it("never follows a linked folder out of a plain folder, even one that turns into a link mid-walk", async () => {
    root = mkdtempSync(join(tmpdir(), "buildwarden-code-map-"));
    outside = mkdtempSync(join(tmpdir(), "buildwarden-code-map-outside-"));
    writeFileSync(join(outside, "secret.ts"), "export const secret = 1;\n");
    write("keep.ts", "export {};\n");
    write("swapped/inside.ts", "export {};\n");
    // A junction on Windows (no privilege needed), a plain symlink elsewhere.
    symlinkSync(outside, join(root, "linked"), "junction");
    fsHooks.afterReaddir = (path) => {
      if (path !== resolve(root)) return;
      fsHooks.afterReaddir = null;
      // The root listing already reported `swapped` as a real folder.
      rmSync(join(root, "swapped"), { recursive: true });
      symlinkSync(outside, join(root, "swapped"), "junction");
    };

    const result = await scanWorkspaceCodeMap(root);
    expect(result.files).toEqual([{ path: "keep.ts", lines: 1 }]);
  });

  it("counts the file it actually reads when the file shrinks after it was checked", async () => {
    root = mkdtempSync(join(tmpdir(), "buildwarden-code-map-"));
    write("notes.md", "one\ntwo\nthree\n");
    fsHooks.afterLstat = (path) => {
      if (path !== resolve(root, "notes.md")) return;
      fsHooks.afterLstat = null;
      writeFileSync(path, "one\n");
    };

    const result = await scanWorkspaceCodeMap(root);
    expect(result.files).toEqual([{ path: "notes.md", lines: 1 }]);
  });

  it("keeps only the bytes it read when the file shrinks after it was opened and sized", async () => {
    root = mkdtempSync(join(tmpdir(), "buildwarden-code-map-"));
    write("notes.md", "one\ntwo\nthree\n");
    fsHooks.afterHandleStat = (path) => {
      if (path !== resolve(root, "notes.md")) return;
      fsHooks.afterHandleStat = null;
      // Truncated in place, so it is still the checked file, only shorter than the buffer sized for it.
      writeFileSync(path, "one\n");
    };

    const result = await scanWorkspaceCodeMap(root);
    expect(result.files).toEqual([{ path: "notes.md", lines: 1 }]);
  });

  // Windows has no no-follow open, and creating a file symlink there needs a privilege.
  it.skipIf(process.platform === "win32")("does not read through a file that turns into a link after it was checked", async () => {
    root = mkdtempSync(join(tmpdir(), "buildwarden-code-map-"));
    outside = mkdtempSync(join(tmpdir(), "buildwarden-code-map-outside-"));
    writeFileSync(join(outside, "secret.ts"), "one\ntwo\nthree\nfour\n");
    write("keep.ts", "export {};\n");
    write("swapped.ts", "export {};\n");
    fsHooks.afterLstat = (path) => {
      if (path !== resolve(root, "swapped.ts")) return;
      fsHooks.afterLstat = null;
      rmSync(path);
      symlinkSync(join(outside, "secret.ts"), path);
    };

    const result = await scanWorkspaceCodeMap(root);
    expect(result.files).toEqual([{ path: "keep.ts", lines: 1 }]);
  });

  // Opening a pipe for reading waits for a writer, so without a non-blocking open this scan never ends.
  it.skipIf(process.platform === "win32")("does not hang on a file that turns into a pipe after it was checked", async () => {
    root = mkdtempSync(join(tmpdir(), "buildwarden-code-map-"));
    write("keep.ts", "export {};\n");
    write("pipe.ts", "export {};\n");
    fsHooks.afterLstat = (path) => {
      if (path !== resolve(root, "pipe.ts")) return;
      fsHooks.afterLstat = null;
      rmSync(path);
      execFileSync("mkfifo", [path]);
    };

    const result = await scanWorkspaceCodeMap(root);
    expect(result.files).toEqual([{ path: "keep.ts", lines: 1 }]);
  });

  // Stands in for a swap to a symlink, which Windows cannot refuse at open time: either way the
  // opened file is no longer the one that was checked, and that is what the scan must notice.
  it("leaves out a file that is replaced by another one between the check and the open", async () => {
    root = mkdtempSync(join(tmpdir(), "buildwarden-code-map-"));
    outside = mkdtempSync(join(tmpdir(), "buildwarden-code-map-outside-"));
    writeFileSync(join(outside, "other.ts"), "one\ntwo\nthree\nfour\n");
    write("keep.ts", "export {};\n");
    write("replaced.ts", "export {};\n");
    fsHooks.afterLstat = (path) => {
      if (path !== resolve(root, "replaced.ts")) return;
      fsHooks.afterLstat = null;
      renameSync(join(outside, "other.ts"), path);
    };

    const result = await scanWorkspaceCodeMap(root);
    expect(result.files).toEqual([{ path: "keep.ts", lines: 1 }]);
  });

  it("still maps a plain folder that is itself reached through a link", async () => {
    root = mkdtempSync(join(tmpdir(), "buildwarden-code-map-"));
    outside = mkdtempSync(join(tmpdir(), "buildwarden-code-map-outside-"));
    writeFileSync(join(outside, "a.ts"), "export {};\n");
    symlinkSync(outside, join(root, "project"), "junction");

    const result = await scanWorkspaceCodeMap(join(root, "project"));
    expect(result.files).toEqual([{ path: "a.ts", lines: 1 }]);
  });

  it("lists a Git workspace relative to the repository root, honoring .gitignore and the workspace subfolder", async () => {
    root = mkdtempSync(join(tmpdir(), "buildwarden-code-map-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(".gitignore", "ignored/\n");
    write("app/src/a.ts", "import './b';\n");
    write("app/src/b.ts", "export {};\n");
    write("app/ignored/skip.ts", "export {};\n");
    write("other/outside.ts", "export {};\n");

    const result = await scanWorkspaceCodeMap(join(root, "app"));
    expect(result.files).toEqual([
      { path: "app/src/a.ts", lines: 1, imports: [1] },
      { path: "app/src/b.ts", lines: 1 },
    ]);
  });
});
