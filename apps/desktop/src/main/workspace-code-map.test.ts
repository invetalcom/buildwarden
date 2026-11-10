import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractImportSpecifiers, resolveCodeMapImports, scanWorkspaceCodeMap } from "./workspace-code-map";

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
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
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
