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

  it("resolves nothing for a name no PATH entry holds, such as a rewritten process title", () => {
    const { root, bin } = setup();
    expect(resolveLaunchProgram("my-worker", root, bin)).toBeNull();
  });
});
