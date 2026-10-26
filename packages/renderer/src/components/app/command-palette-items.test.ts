import { describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "@buildwarden/shared";
import { buildCommandPaletteItems, type CommandPaletteItemDeps } from "./command-palette-items";

const deps = (overrides: Partial<CommandPaletteItemDeps> = {}): CommandPaletteItemDeps => ({
  snapshot: { projects: [], chats: [] } as unknown as AppSnapshot,
  targetProjectId: "",
  onSelectLanding: vi.fn(),
  onSelectAllRuns: vi.fn(),
  onSelectChats: vi.fn(),
  onSelectBookmarks: vi.fn(),
  onOpenSettings: vi.fn(),
  onSelectProject: vi.fn(),
  onSelectProjectFeature: vi.fn(),
  onSelectRun: vi.fn(),
  onSelectChat: vi.fn(),
  onToggleTheme: vi.fn(),
  ...overrides,
});

describe("usage & cost command", () => {
  it("is offered only while usage cost tracking is on", () => {
    expect(buildCommandPaletteItems(deps()).some((item) => item.id === "workspace-usage")).toBe(false);

    const onOpenUsage = vi.fn();
    const item = buildCommandPaletteItems(deps({ onOpenUsage })).find((entry) => entry.id === "workspace-usage");
    expect(item).toMatchObject({ title: "Open usage & cost", section: "Navigate" });
    void item?.onSelect();
    expect(onOpenUsage).toHaveBeenCalledOnce();
  });
});
