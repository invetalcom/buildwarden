import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ProjectForgeIssueTemplate, ProjectForgeProvider } from "@buildwarden/shared";

const MAX_TEMPLATES = 20;
const MAX_TEMPLATE_BYTES = 64 * 1024;

const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");

/** `'bug, triage'` is one quoted scalar holding the whole list; `"bug", "triage"` is a list of quoted entries. */
const unquoteScalar = (value: string): string => value.trim().replace(/^(["'])((?:(?!\1).)*)\1$/, "$2");

const parseList = (value: string): string[] =>
  unquoteScalar(value)
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(unquote)
    .filter(Boolean);

/**
 * Reads the simple `key: value` front matter GitHub issue templates use.
 * Block lists (`labels:` followed by `- item` lines) are supported; nested YAML is not.
 */
export const parseForgeIssueTemplate = (fileName: string, content: string): ProjectForgeIssueTemplate => {
  const fallbackName = fileName.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || fileName;
  const normalized = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { name: fallbackName, description: null, title: "", body: normalized.trim(), labels: [] };

  const fields = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let openList: string | null = null;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && openList) {
      lists.get(openList)?.push(unquote(item[1] ?? ""));
      continue;
    }
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!field?.[1]) continue;
    const key = field[1].toLowerCase();
    const value = (field[2] ?? "").trim();
    if (value) {
      fields.set(key, value);
      openList = null;
    } else {
      lists.set(key, []);
      openList = key;
    }
  }

  const labelField = fields.get("labels");
  return {
    name: unquote(fields.get("name") ?? "") || fallbackName,
    description: unquote(fields.get("about") ?? fields.get("description") ?? "") || null,
    title: unquote(fields.get("title") ?? ""),
    body: (match[2] ?? "").trim(),
    labels: (labelField ? parseList(labelField) : (lists.get("labels") ?? [])).filter(Boolean),
  };
};

const templateDirectories = (provider: ProjectForgeProvider): string[] =>
  provider === "gitlab" ? [".gitlab/issue_templates"] : [".github/ISSUE_TEMPLATE", ".github/issue_template", "docs/ISSUE_TEMPLATE"];

const isInside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
};

/**
 * Markdown issue templates checked into the project. YAML issue forms are skipped: they are not plain issue text.
 * A checkout is not trusted: a template or template folder that is a link to somewhere outside it is not read.
 */
export const readForgeIssueTemplates = async (repoPath: string, provider: ProjectForgeProvider): Promise<ProjectForgeIssueTemplate[]> => {
  const templates: ProjectForgeIssueTemplate[] = [];
  let root: string;
  try {
    root = await realpath(repoPath);
  } catch {
    return templates;
  }
  for (const directory of templateDirectories(provider)) {
    let directoryPath: string;
    let entries: string[];
    try {
      directoryPath = await realpath(join(root, directory));
      if (!isInside(root, directoryPath)) continue;
      entries = (await readdir(directoryPath)).filter((entry) => /\.md$/i.test(entry)).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (templates.length >= MAX_TEMPLATES) return templates;
      try {
        const filePath = await realpath(join(directoryPath, entry));
        if (!isInside(root, filePath)) continue;
        const info = await stat(filePath);
        if (!info.isFile() || info.size > MAX_TEMPLATE_BYTES) continue;
        templates.push(parseForgeIssueTemplate(entry, await readFile(filePath, "utf8")));
      } catch {
        // A template that cannot be read is simply not offered.
      }
    }
    if (templates.length > 0) return templates;
  }
  return templates;
};
