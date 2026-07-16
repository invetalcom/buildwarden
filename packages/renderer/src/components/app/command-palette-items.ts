import type { AppSnapshot, ChatRecord, RunRecord } from "@buildwarden/shared";
import {
  Bookmark,
  Bot,
  Command as CommandIcon,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Home,
  MessageSquareText,
  Settings,
  Sparkles,
} from "lucide-react";
import type { CommandPaletteItem } from "./CommandPalette";
import type { ProjectPageTab } from "./project-page-tabs";

const formatRunWorkspaceLabel = (run: RunRecord): string => {
  if (run.workspaceVcs === "folder") {
    return run.workspaceType === "copy" ? "Folder copy" : "Project folder";
  }
  return run.branchName;
};

export interface CommandPaletteItemDeps {
  snapshot: AppSnapshot;
  targetProjectId: string;
  onSelectLanding: () => void | Promise<void>;
  onSelectAllRuns: () => void | Promise<void>;
  onSelectChats: () => void | Promise<void>;
  onSelectBookmarks: () => void | Promise<void>;
  onOpenSettings: () => void | Promise<void>;
  onSelectProject: (projectId: string) => void | Promise<void>;
  onSelectProjectFeature: (projectId: string, tab: ProjectPageTab) => void | Promise<void>;
  onSelectRun: (projectId: string, runId: string) => void | Promise<void>;
  onSelectChat: (chat: Pick<ChatRecord, "id">) => void | Promise<void>;
  onToggleTheme: () => void | Promise<void>;
}

const buildWorkspaceItems = (deps: CommandPaletteItemDeps): CommandPaletteItem[] => [
  {
    id: "workspace-home",
    title: "Go home",
    subtitle: "Open the workspace overview",
    section: "Navigate",
    icon: Home,
    keywords: ["dashboard", "landing"],
    onSelect: () => deps.onSelectLanding(),
  },
  {
    id: "workspace-all-runs",
    title: "Open all runs",
    subtitle: "Search and browse runs across projects",
    section: "Navigate",
    icon: Bot,
    keywords: ["history", "agent"],
    onSelect: () => deps.onSelectAllRuns(),
  },
  {
    id: "workspace-chats",
    title: "Open chats",
    subtitle: "Start or continue a chat",
    section: "Navigate",
    icon: MessageSquareText,
    keywords: ["conversation"],
    onSelect: () => deps.onSelectChats(),
  },
  {
    id: "workspace-bookmarks",
    title: "Open bookmarks",
    subtitle: "Saved chats and agent runs",
    section: "Navigate",
    icon: Bookmark,
    keywords: ["saved"],
    onSelect: () => deps.onSelectBookmarks(),
  },
  {
    id: "workspace-settings",
    title: "Open settings",
    subtitle: "Providers, workspace behavior, shortcuts, and app settings",
    section: "Navigate",
    icon: Settings,
    keywords: ["preferences", "config"],
    onSelect: () => deps.onOpenSettings(),
  },
  {
    id: "workspace-new-run",
    title: "New agent run",
    subtitle: deps.targetProjectId ? "Open the selected project run composer" : "Add a project first",
    section: "Action",
    icon: Sparkles,
    disabled: !deps.targetProjectId,
    keywords: ["agent", "composer", "start"],
    onSelect: () => (deps.targetProjectId ? deps.onSelectProject(deps.targetProjectId) : undefined),
  },
  {
    id: "workspace-toggle-theme",
    title: "Toggle theme",
    subtitle: "Toggle dark and light mode",
    section: "Action",
    icon: CommandIcon,
    keywords: ["appearance", "light", "dark"],
    onSelect: () => deps.onToggleTheme(),
  },
];

const buildProjectItems = (deps: CommandPaletteItemDeps): CommandPaletteItem[] => {
  const items: CommandPaletteItem[] = [];
  for (const entry of deps.snapshot.projects) {
    items.push({
      id: `project-${entry.project.id}`,
      title: `Open ${entry.project.name}`,
      subtitle: entry.project.repoPath,
      section: "Project",
      icon: FolderOpen,
      keywords: ["overview", entry.project.kind === "git" ? entry.project.baseBranch : "folder"],
      onSelect: () => deps.onSelectProject(entry.project.id),
    });
    if (entry.project.kind === "git") {
      items.push(
        {
          id: `project-${entry.project.id}-branches`,
          title: `${entry.project.name}: Branches`,
          subtitle: "Manage local and remote branches",
          section: "Project",
          icon: GitBranch,
          keywords: ["git", "checkout", "fetch", "pull"],
          onSelect: () => deps.onSelectProjectFeature(entry.project.id, "branches"),
        },
        {
          id: `project-${entry.project.id}-reviews`,
          title: `${entry.project.name}: Pull / merge requests`,
          subtitle: "Review PRs and MRs",
          section: "Project",
          icon: GitPullRequest,
          keywords: ["review", "mr", "pr"],
          onSelect: () => deps.onSelectProjectFeature(entry.project.id, "reviews"),
        },
      );
    }
  }
  return items;
};

const buildRecentRunItems = (deps: CommandPaletteItemDeps): CommandPaletteItem[] =>
  deps.snapshot.projects
    .flatMap((entry) =>
      [...entry.runs, ...entry.forLaterRuns].map((run) => ({
        projectId: entry.project.id,
        projectName: entry.project.name,
        run,
      })),
    )
    .sort((left, right) => new Date(right.run.updatedAt).getTime() - new Date(left.run.updatedAt).getTime())
    .slice(0, 10)
    .map((item) => {
      const workspaceLabel = formatRunWorkspaceLabel(item.run);
      return {
        id: `run-${item.run.id}`,
        title: item.run.prompt,
        subtitle: `${item.projectName} - ${item.run.status} - ${workspaceLabel}`,
        section: "Run",
        icon: Bot,
        keywords: [item.run.id, item.run.status, item.projectName, workspaceLabel],
        onSelect: () => deps.onSelectRun(item.projectId, item.run.id),
      };
    });

const buildRecentChatItems = (deps: CommandPaletteItemDeps): CommandPaletteItem[] =>
  [...deps.snapshot.chats]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, 8)
    .map((chat) => ({
      id: `chat-${chat.id}`,
      title: chat.prompt,
      subtitle: `Chat - ${chat.status} - ${new Date(chat.createdAt).toLocaleString()}`,
      section: "Chat",
      icon: MessageSquareText,
      keywords: [chat.id, chat.status],
      onSelect: () => deps.onSelectChat(chat),
    }));

export const buildCommandPaletteItems = (deps: CommandPaletteItemDeps): CommandPaletteItem[] => [
  ...buildWorkspaceItems(deps),
  ...buildProjectItems(deps),
  ...buildRecentRunItems(deps),
  ...buildRecentChatItems(deps),
];
