import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessRunChunk, SkillRuntimeInput } from "@buildwarden/shared";
import { createSkillRuntime } from "./skill-runtime";
import { emptySkillSnapshot } from "./skill-service";
import { parseSkillPackage, skillPackagePath, storeSkillFiles } from "./skill-packages";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const setup = async () => {
  const storePath = await mkdtemp(join(tmpdir(), "buildwarden-skill-runtime-")); roots.push(storePath);
  const files = new Map([["SKILL.md", Buffer.from("---\nname: example\ndescription: Test workflow\n---\nINSTRUCTION_SENTINEL. Read references/guide.md.")], ["references/guide.md", Buffer.from("REFERENCE_SENTINEL")], ["assets/data.bin", Buffer.from([0, 255])]]);
  await storeSkillFiles(storePath, files);
  const record = parseSkillPackage(files, { source: "local", path: storePath });
  const snapshot = { ...emptySkillSnapshot(), packages: [record], selectedIds: [record.metadata.id] };
  const input: SkillRuntimeInput = { snapshot, storePath, recovering: false };
  const chunks: HarnessRunChunk[] = [];
  return { input, record, chunks, id: record.metadata.id, onChunk: (chunk: HarnessRunChunk) => { chunks.push(chunk); } };
};

describe("progressive skill runtime", () => {
  it("starts with metadata, loads full instructions on demand, and exposes references even when the body fits", async () => {
    const fixture = await setup();
    const runtime = await createSkillRuntime(fixture.input, fixture.onChunk);
    expect(runtime.context).toContain("Test workflow");
    expect(runtime.context).not.toContain("INSTRUCTION_SENTINEL");
    const loaded = await runtime.tools.executeTool({ id: "load", name: "buildwarden_load_skill", arguments: { id: fixture.id } });
    expect(loaded.ok).toBe(true);
    expect(loaded.content).toContain("INSTRUCTION_SENTINEL");
    expect(loaded.content).toContain("references/guide.md");
    expect(loaded.content).not.toContain("REFERENCE_SENTINEL");
    const resource = await runtime.tools.executeTool({ id: "read", name: "buildwarden_read_skill_resource", arguments: { id: fixture.id, path: "references/guide.md" } });
    expect(resource.content).toContain("REFERENCE_SENTINEL");
    expect(fixture.chunks.find((chunk) => chunk.metadata?.skillStatus === "loaded")?.metadata).toMatchObject({ skillHash: fixture.record.hash });
  });

  it("loads explicitly invoked skills and restores previously loaded instructions during recovery", async () => {
    const fixture = await setup();
    fixture.input.snapshot.explicitIds = [fixture.id];
    expect((await createSkillRuntime(fixture.input, fixture.onChunk)).context).toContain("INSTRUCTION_SENTINEL");
    fixture.input.snapshot.explicitIds = [];
    fixture.input.snapshot.loadedIds = [fixture.id];
    expect((await createSkillRuntime({ ...fixture.input, recovering: true }, fixture.onChunk)).context).toContain("INSTRUCTION_SENTINEL");
    expect((await createSkillRuntime(fixture.input, fixture.onChunk)).context).not.toContain("INSTRUCTION_SENTINEL");
  });

  it("rejects traversal, unknown skills, tampering, and missing references", async () => {
    const fixture = await setup();
    const runtime = await createSkillRuntime(fixture.input, fixture.onChunk);
    for (const args of [{ id: "other", path: "references/guide.md" }, { id: fixture.id, path: "../secret" }, { id: fixture.id, path: "references/missing.md" }]) {
      expect((await runtime.tools.executeTool({ id: "read", name: "buildwarden_read_skill_resource", arguments: args })).ok).toBe(false);
    }
    expect(fixture.chunks.some((chunk) => chunk.metadata?.skillStatus === "unavailable")).toBe(false);
    await writeFile(join(skillPackagePath(fixture.input.storePath, fixture.record.hash), "SKILL.md"), "tampered");
    const fresh = await createSkillRuntime(fixture.input, fixture.onChunk);
    const result = await fresh.tools.executeTool({ id: "load", name: "buildwarden_load_skill", arguments: { id: fixture.id } });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("integrity");
  });

  it("provides bounded direct instructions for text-only models without advertising tools", async () => {
    const fixture = await setup();
    const runtime = await createSkillRuntime(fixture.input, fixture.onChunk, false);
    expect(runtime.context).toContain("INSTRUCTION_SENTINEL");
    expect(runtime.tools.tools).toEqual([]);
    expect(runtime.context).toContain("cannot be read in this chat");
    expect(runtime.context).not.toContain("call buildwarden_load_skill");
  });

  it("reports every catalog omission instead of silently dropping selected skills", async () => {
    const fixture = await setup();
    fixture.input.snapshot.packages = Array.from({ length: 100 }, (_, index) => ({ ...fixture.record, metadata: { ...fixture.record.metadata, id: `skill-${index}`, description: "x".repeat(1024) } }));
    const runtime = await createSkillRuntime(fixture.input, fixture.onChunk);
    const omissions = fixture.chunks.filter((chunk) => chunk.metadata?.skillStatus === "omitted");
    const ids = runtime.context.split("\n").filter((line) => line.startsWith("{\"id\":"));
    expect(JSON.stringify(runtime.tools.tools)).not.toContain("enum");
    expect(omissions.length).toBeGreaterThan(0);
    expect(ids.length + omissions.length).toBe(100);
  });

  it("returns binary asset paths without executing scripts or decoding corrupt text", async () => {
    const fixture = await setup();
    const runtime = await createSkillRuntime(fixture.input, fixture.onChunk);
    const result = await runtime.tools.executeTool({ id: "read", name: "buildwarden_read_skill_resource", arguments: { id: fixture.id, path: "assets/data.bin" } });
    expect(JSON.parse(result.content)).toMatchObject({ binary: true, bytes: 2 });
  });

  it("registers no tools and emits no context for an empty selection", async () => {
    const runtime = await createSkillRuntime(undefined, () => {});
    expect(runtime.context).toBe("");
    expect(runtime.tools.tools).toEqual([]);
  });

  it("tells the model when an explicit selection is unavailable", async () => {
    const fixture = await setup();
    fixture.input.snapshot.packages = [];
    fixture.input.snapshot.diagnostics = [{ skillId: fixture.id, status: "disabled" }];
    const runtime = await createSkillRuntime(fixture.input, fixture.onChunk);
    expect(runtime.tools.tools).toEqual([]);
    expect(runtime.context).toContain("do not infer");
    expect(runtime.context).toContain(fixture.id);
  });
});
