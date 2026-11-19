import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLaunchProgram } from "./launch-program";

describe("resolveLaunchProgram", () => {
  let root: string | null = null;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  const setup = () => {
    root = mkdtempSync(join(tmpdir(), "launch-program-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const tool = join(bin, "tool");
    writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
    return { root, bin, tool: realpathSync(tool) };
  };

  it("finds a bare name in PATH and a path relative to the working folder", () => {
    const { root, bin, tool } = setup();
    expect(resolveLaunchProgram("tool", root, ["/nowhere", bin].join(delimiter))).toBe(tool);
    expect(resolveLaunchProgram("./bin/tool", root, "")).toBe(tool);
  });

  it.each([
    ["leading", (bin: string) => ["", bin]],
    ["middle", (bin: string) => [bin, "", bin]],
    ["trailing", (bin: string) => [bin, ""]],
  ])("treats a %s empty PATH entry as the working folder", (_position, entries) => {
    const { root, bin } = setup();
    // The working folder's own `tool` wins wherever the empty entry comes before `bin`.
    writeFileSync(join(root, "tool"), "#!/bin/sh\n", { mode: 0o755 });
    const local = realpathSync(join(root, "tool"));
    const path = entries(bin).join(delimiter);
    expect(resolveLaunchProgram("tool", root, path)).toBe(path.startsWith(delimiter) ? local : realpathSync(join(bin, "tool")));
    expect(resolveLaunchProgram("tool", root, entries("/nowhere").join(delimiter))).toBe(local);
  });

  it("skips a directory with the program's name and keeps searching PATH", () => {
    const { root, bin, tool } = setup();
    // An empty entry puts the working folder first; its `tool` is a folder, not a program.
    mkdirSync(join(root, "tool"));
    expect(resolveLaunchProgram("tool", root, ["", bin].join(delimiter))).toBe(tool);
    mkdirSync(join(root, "only-dir"));
    expect(resolveLaunchProgram("only-dir", root, "")).toBeNull();
  });

  it("resolves nothing for a name no PATH entry holds, such as a rewritten process title", () => {
    const { root, bin } = setup();
    expect(resolveLaunchProgram("my-worker", root, bin)).toBeNull();
  });
});
