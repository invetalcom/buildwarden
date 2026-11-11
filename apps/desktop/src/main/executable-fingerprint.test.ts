import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executableFingerprint, resolveExecutable } from "./executable-fingerprint";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const binDirectory = () => {
  const root = mkdtempSync(join(tmpdir(), "bw-exe-"));
  roots.push(root);
  return root;
};

describe("executable lookup", () => {
  it("finds a bare command on PATH, trying PATHEXT extensions on Windows", () => {
    const bin = binDirectory();
    writeFileSync(join(bin, "agent.CMD"), "@echo off");
    writeFileSync(join(bin, "tool"), "#!/bin/sh");
    expect(resolveExecutable("agent", { PATH: bin, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(join(bin, "agent.CMD"));
    expect(resolveExecutable("tool", { PATH: `${binDirectory()}${delimiter}${bin}` }, process.platform)).toBe(join(bin, "tool"));
    expect(resolveExecutable("missing", { PATH: bin }, process.platform)).toBeNull();
  });

  it("takes an absolute path as it is and leaves relative paths alone", () => {
    const bin = binDirectory();
    const agent = join(bin, "agent.exe");
    writeFileSync(agent, "build");
    expect(resolveExecutable(agent, {}, process.platform)).toBe(agent);
    expect(resolveExecutable("./agent.exe", { PATH: bin }, process.platform)).toBeNull();
  });

  it("changes its fingerprint when another build is installed", () => {
    const bin = binDirectory();
    const agent = join(bin, "agent.exe");
    writeFileSync(agent, "build 1");
    const first = executableFingerprint(agent);
    expect(first).toContain(agent);
    expect(executableFingerprint(agent)).toBe(first);
    writeFileSync(agent, "build 2 is larger");
    expect(executableFingerprint(agent)).not.toBe(first);
    expect(executableFingerprint(join(bin, "gone.exe"))).toBeNull();
  });
});
