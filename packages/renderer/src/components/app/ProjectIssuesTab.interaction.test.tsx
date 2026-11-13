/** @vitest-environment happy-dom */

import {
  EMPTY_PROJECT_FORGE_ISSUE_PREFERENCES,
  type DesktopApi,
  type ProjectForgeIssueAccess,
  type ProjectForgeIssueDetailsResult,
  type ProjectForgeIssueSummary,
  type ProjectForgeIssuesResult,
} from "@buildwarden/shared";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ProjectForgeTab } from "./ProjectForgeTab";
import { ProjectIssuesTab } from "./ProjectIssuesTab";

// The PR view pulls in the diff renderer, which needs a browser layout engine.
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

const anonymousAccess: ProjectForgeIssueAccess = { mode: "anonymous", canWrite: false, canTriage: false, viewer: null, rateLimit: { limit: 60, remaining: 41, resetAt: null } };
const tokenAccess: ProjectForgeIssueAccess = { mode: "token", canWrite: true, canTriage: true, viewer: "maintainer", rateLimit: null };

const issue = (number: number, title: string): ProjectForgeIssueSummary => ({
  provider: "github",
  number,
  title,
  url: `https://github.com/acme/widgets/issues/${String(number)}`,
  state: "open",
  stateReason: null,
  author: "lexrus",
  authorUser: null,
  labels: [{ name: "severity: low", color: "0e8a16", description: null }],
  assignees: [],
  milestone: null,
  commentCount: 1,
  bodyPreview: "",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-02T10:00:00Z",
  closedAt: null,
  locked: false,
  confidential: false,
  weight: null,
  issueType: null,
  epic: null,
  taskProgress: null,
  reactions: [],
});

const issues = [issue(183, "Default test runs must be headless"), issue(141, "Connection HUD omits battery levels")];

const listResult = (access: ProjectForgeIssueAccess, overrides: Partial<ProjectForgeIssuesResult> = {}): ProjectForgeIssuesResult => ({
  provider: "github",
  webBaseUrl: "https://github.com/acme/widgets",
  repoLabel: "acme/widgets",
  access,
  unavailable: null,
  items: issues,
  links: [],
  page: 1,
  hasMore: false,
  fetchedAt: "2026-11-11T12:00:00Z",
  fromCache: false,
  ...overrides,
});

const detailsResult = (access: ProjectForgeIssueAccess, number: number): ProjectForgeIssueDetailsResult => ({
  provider: "github",
  webBaseUrl: "https://github.com/acme/widgets",
  repoLabel: "acme/widgets",
  access,
  issue: { ...(issues.find((entry) => entry.number === number) ?? issue(number, "Other issue")), body: "Tests open a visible window." },
  timeline: [{ itemKey: "comment-1", kind: "comment", title: "", body: "Happens on CI too.", author: { username: "hubot", name: null, avatarUrl: null, webUrl: null }, createdAt: "2026-11-02T09:00:00Z", updatedAt: null, url: null, reactions: [] }],
  linkedRequests: [],
  subIssues: [],
  links: [],
  warnings: [],
  fetchedAt: "2026-11-11T12:00:00Z",
});

const createApi = (access: ProjectForgeIssueAccess, overrides: Partial<DesktopApi> = {}) =>
  ({
    listProjectForgeIssues: vi.fn(async () => listResult(access)),
    getProjectForgeIssueDetails: vi.fn(async (_projectId: string, input: { issueNumber: number }) => detailsResult(access, input.issueNumber)),
    getProjectForgeIssueMetadata: vi.fn(async () => ({ labels: [], milestones: [], assignees: [], templates: [], warnings: [] })),
    commentProjectForgeIssue: vi.fn(async () => ({ message: "Comment posted on #183.", url: null, issue: issues[0]! })),
    getProjectForgeAuthStatus: vi.fn(async () => ({ provider: "github" as const, webBaseUrl: "https://github.com", repoLabel: "acme/widgets", hasToken: false })),
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }) as unknown as DesktopApi;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];
let projectSequence = 0;

const text = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "";
const findButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => text(button) === label);
const findButtonContaining = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => text(button).includes(label));

const waitFor = async <T,>(read: () => T | undefined | null | false): Promise<T> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = read();
    if (value) return value;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for the issues UI to settle.");
};

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
  });
};

const typeInto = async (element: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

type IssuesTabProps = ComponentProps<typeof ProjectIssuesTab>;

const renderIssues = async (api: DesktopApi, props: Partial<IssuesTabProps> = {}) => {
  projectSequence += 1;
  const handlers = {
    onSavePreferences: vi.fn(async () => {}),
    onStartIssueRuns: vi.fn(async () => {}),
    onAskIssue: vi.fn(async () => {}),
    onWorkChanged: vi.fn(),
    onOpenProjectSettings: vi.fn(),
    onSelectRun: vi.fn(),
    onOpenChat: vi.fn(),
    onOpenTaskBoard: vi.fn(),
    onOpenRequest: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient(api)}>
        <ProjectIssuesTab
          projectId={`project-issues-${String(projectSequence)}`}
          baseBranch="main"
          runs={[]}
          tasks={[]}
          chats={[]}
          modelOptions={[{ id: "model-1", label: "Fable" }]}
          defaultModelId="model-1"
          preferences={EMPTY_PROJECT_FORGE_ISSUE_PREFERENCES}
          {...handlers}
          {...props}
        />
      </BuildWardenClientProvider>,
    );
  });
  return { container, handlers };
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("ProjectIssuesTab", () => {
  it("lists issues without a token as read-only and keeps reading, chat, and runs available", async () => {
    const api = createApi(anonymousAccess);
    const { container } = await renderIssues(api);

    await waitFor(() => findButtonContaining("Default test runs must be headless"));
    expect(text(container)).toContain("Read-only · 41/60 requests left");
    expect(findButton("New issue")?.disabled).toBe(true);
    // Labels and milestones are not fetched without a token: every request counts.
    expect(api.getProjectForgeIssueMetadata).not.toHaveBeenCalled();

    await click(findButtonContaining("Default test runs must be headless")!);
    await waitFor(() => text(container).includes("Tests open a visible window."));
    expect(text(container)).toContain("Happens on CI too.");
    expect(text(container)).toContain("Commenting is off: needs a git hosting access token.");
    expect(container.querySelector('textarea[aria-label="Comment"]')).toBeNull();
    expect(findButton("Close")?.disabled).toBe(true);
    expect(findButton("Start run")?.disabled).toBe(false);
    expect(findButton("Ask")?.disabled).toBe(false);
  });

  it("posts a comment with a token and clears the draft", async () => {
    const api = createApi(tokenAccess);
    const { container } = await renderIssues(api);
    await click(await waitFor(() => findButtonContaining("Default test runs must be headless")));
    const textarea = await waitFor(() => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]'));

    await typeInto(textarea, "Fixed in the next release.");
    await click(await waitFor(() => findButton("Comment")));

    await waitFor(() => text(container).includes("Comment posted on #183."));
    expect(api.commentProjectForgeIssue).toHaveBeenCalledWith(expect.any(String), { issueNumber: 183, body: "Fixed in the next release." });
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')?.value).toBe("");
    expect(findButton("New issue")?.disabled).toBe(false);
  });

  it("hands the issue to a run as an attached, quoted context file", async () => {
    const api = createApi(tokenAccess);
    const { container, handlers } = await renderIssues(api);
    await click(await waitFor(() => findButtonContaining("Default test runs must be headless")));
    await waitFor(() => text(container).includes("Tests open a visible window."));

    await click(findButton("Start run")!);
    await click(await waitFor(() => findButton("Investigate only")));
    const start = await waitFor(() => Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find((button) => text(button) === "Start run"));
    await click(start);

    await waitFor(() => handlers.onStartIssueRuns.mock.calls.length > 0);
    const [requests, options] = handlers.onStartIssueRuns.mock.calls[0] as unknown as [Array<{ issue: unknown; prompt: string; attachments: Array<{ fileName: string; mimeType: string; dataBase64: string }> }>, unknown];
    expect(options).toMatchObject({ modelId: "model-1", mode: "plan" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.issue).toMatchObject({ number: 183, provider: "github", url: "https://github.com/acme/widgets/issues/183" });
    expect(requests[0]?.prompt).toContain("Do not change any code yet.");
    expect(requests[0]?.attachments[0]).toMatchObject({ fileName: "issue-183.md", mimeType: "text/markdown" });
    const context = new TextDecoder().decode(Uint8Array.from(atob(requests[0]?.attachments[0]?.dataBase64 ?? ""), (char) => char.charCodeAt(0)));
    expect(context).toContain("> Tests open a visible window.");
    expect(context).toContain("> Happens on CI too.");
  });

  it("retries only the issues whose run did not start when a batch fails halfway", async () => {
    const api = createApi(tokenAccess);
    const onStartIssueRuns = vi.fn<IssuesTabProps["onStartIssueRuns"]>();
    onStartIssueRuns
      .mockImplementationOnce(async (requests, options) => {
        options.onRunStarted?.(requests[0]!.issue);
        throw new Error("No free worktree slot.");
      })
      .mockImplementation(async (requests, options) => requests.forEach((request) => options.onRunStarted?.(request.issue)));
    const { container } = await renderIssues(api, { onStartIssueRuns });
    await waitFor(() => findButtonContaining("Default test runs must be headless"));
    for (const checkbox of Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) await click(checkbox);
    await click(await waitFor(() => findButton("Start runs")));
    await click(await waitFor(() => findButton("Start 2 runs")));

    // #183 runs; the dialog now only offers #141 and says what happened.
    await waitFor(() => text(document.body).includes("1 of 2 runs started."));
    expect(text(document.body)).toContain("No free worktree slot.");
    const retry = await waitFor(() => Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find((button) => text(button) === "Start run"));
    await click(retry);

    await waitFor(() => onStartIssueRuns.mock.calls.length > 1);
    expect(onStartIssueRuns.mock.calls.map(([requests]) => requests.map((request) => request.issue.number))).toEqual([[183, 141], [141]]);
  });

  it("says why an issue that is not in the list could not be opened, and offers to try again", async () => {
    const getDetails = vi.fn<DesktopApi["getProjectForgeIssueDetails"]>();
    getDetails.mockRejectedValueOnce(new Error("GitHub API request timed out after 30 seconds.")).mockImplementation(async (_projectId, input) => detailsResult(tokenAccess, input.issueNumber));
    const api = createApi(tokenAccess, { getProjectForgeIssueDetails: getDetails });
    // #99 is closed, so the list of open issues does not contain it.
    const { container } = await renderIssues(api, { initialIssue: { number: 99, requestId: 1 } });

    await waitFor(() => text(container).includes("Issue #99 could not be loaded"));
    expect(text(container)).toContain("timed out");
    await click(findButton("Try again")!);
    await waitFor(() => text(container).includes("Tests open a visible window."));
  });

  it("keeps the refreshed conversation when an earlier request for the issue answers late", async () => {
    let answerFirst: (value: ProjectForgeIssueDetailsResult) => void = () => {};
    const first = new Promise<ProjectForgeIssueDetailsResult>((resolve) => { answerFirst = resolve; });
    const refreshed = (): ProjectForgeIssueDetailsResult => {
      const result = detailsResult(tokenAccess, 183);
      return { ...result, timeline: [...result.timeline, { ...result.timeline[0]!, itemKey: "comment-2", body: "Fixed in the next release." }] };
    };
    const getDetails = vi.fn<DesktopApi["getProjectForgeIssueDetails"]>();
    getDetails.mockReturnValueOnce(first).mockImplementation(async () => refreshed());
    const api = createApi(tokenAccess, { getProjectForgeIssueDetails: getDetails });
    const { container } = await renderIssues(api);
    await click(await waitFor(() => findButtonContaining("Default test runs must be headless")));

    // The comment is posted while the first request for the conversation is still on its way.
    await typeInto(await waitFor(() => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')), "Fixed in the next release.");
    await click(await waitFor(() => findButton("Comment")));
    await waitFor(() => text(container).includes("Fixed in the next release."));

    await act(async () => {
      answerFirst(detailsResult(tokenAccess, 183));
    });
    expect(text(container)).toContain("Fixed in the next release.");
  });

  it("hands over the current issue text when the issue changed after it was opened", async () => {
    let version = { updatedAt: "2026-11-02T10:00:00Z", body: "Tests open a visible window." };
    const api = createApi(tokenAccess, {
      listProjectForgeIssues: vi.fn(async () => listResult(tokenAccess, { items: issues.map((entry) => (entry.number === 183 ? { ...entry, updatedAt: version.updatedAt } : entry)) })),
      getProjectForgeIssueDetails: vi.fn(async (_projectId: string, input: { issueNumber: number }) => {
        const result = detailsResult(tokenAccess, input.issueNumber);
        return { ...result, issue: { ...result.issue, ...version } };
      }),
    });
    const { container, handlers } = await renderIssues(api);
    await click(await waitFor(() => findButtonContaining("Default test runs must be headless")));
    await waitFor(() => text(container).includes("Tests open a visible window."));

    // The issue is edited on the host; only the list is fetched again.
    version = { updatedAt: "2026-11-12T08:00:00Z", body: "Tests open two visible windows." };
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Fetch issues again"]')!);
    await waitFor(() => vi.mocked(api.listProjectForgeIssues).mock.calls.length > 1);

    await click(findButton("Start run")!);
    const start = await waitFor(() => Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find((button) => text(button) === "Start run"));
    await click(start);
    await waitFor(() => handlers.onStartIssueRuns.mock.calls.length > 0);

    const [requests] = handlers.onStartIssueRuns.mock.calls[0] as unknown as [Array<{ attachments: Array<{ dataBase64: string }> }>];
    const context = new TextDecoder().decode(Uint8Array.from(atob(requests[0]?.attachments[0]?.dataBase64 ?? ""), (char) => char.charCodeAt(0)));
    expect(context).toContain("> Tests open two visible windows.");
    expect(api.getProjectForgeIssueDetails).toHaveBeenLastCalledWith(expect.any(String), { issueNumber: 183, refresh: true });
  });

  it("keeps a reloaded conversation when the context request of a run answers late", async () => {
    let listedUpdatedAt = "2026-11-02T10:00:00Z";
    let answerContext: (value: ProjectForgeIssueDetailsResult) => void = () => {};
    const contextAnswer = new Promise<ProjectForgeIssueDetailsResult>((resolve) => { answerContext = resolve; });
    const reloaded = (): ProjectForgeIssueDetailsResult => {
      const result = detailsResult(tokenAccess, 183);
      return { ...result, timeline: [...result.timeline, { ...result.timeline[0]!, itemKey: "comment-2", body: "Fixed in the next release." }] };
    };
    const getDetails = vi.fn<DesktopApi["getProjectForgeIssueDetails"]>();
    // Opening the issue, then the context for the run (answers late), then the reload.
    getDetails.mockImplementationOnce(async () => detailsResult(tokenAccess, 183)).mockReturnValueOnce(contextAnswer).mockImplementation(async () => reloaded());
    const api = createApi(tokenAccess, {
      listProjectForgeIssues: vi.fn(async () => listResult(tokenAccess, { items: issues.map((entry) => (entry.number === 183 ? { ...entry, updatedAt: listedUpdatedAt } : entry)) })),
      getProjectForgeIssueDetails: getDetails,
    });
    const { container, handlers } = await renderIssues(api);
    await click(await waitFor(() => findButtonContaining("Default test runs must be headless")));
    await waitFor(() => text(container).includes("Tests open a visible window."));

    // The list shows a newer version, so starting a run asks for the issue again.
    listedUpdatedAt = "2026-11-12T08:00:00Z";
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Fetch issues again"]')!);
    await waitFor(() => vi.mocked(api.listProjectForgeIssues).mock.calls.length > 1);
    await click(findButton("Start run")!);
    await click(await waitFor(() => Array.from(document.querySelectorAll<HTMLButtonElement>("dialog button")).find((button) => text(button) === "Start run")));
    await waitFor(() => getDetails.mock.calls.length > 1);

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Reload this issue"]')!);
    await waitFor(() => text(container).includes("Fixed in the next release."));

    await act(async () => {
      answerContext(detailsResult(tokenAccess, 183));
    });
    await waitFor(() => handlers.onStartIssueRuns.mock.calls.length > 0);
    expect(text(container)).toContain("Fixed in the next release.");
  });

  it("puts a drafted reply under what was typed while the model was writing", async () => {
    let finishDraft: (value: { kind: "reply"; text: string }) => void = () => {};
    const api = createApi(tokenAccess, {
      assistProjectForgeIssue: vi.fn(() => new Promise<{ kind: "reply"; text: string }>((resolve) => { finishDraft = resolve; })) as unknown as DesktopApi["assistProjectForgeIssue"],
    });
    const { container } = await renderIssues(api);
    await click(await waitFor(() => findButtonContaining("Default test runs must be headless")));
    const textarea = await waitFor(() => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]'));

    await click(findButton("Draft")!);
    const instructions = await waitFor(() => container.querySelector<HTMLInputElement>('input[aria-label="Instructions for the comment draft"]'));
    await act(async () => {
      instructions.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => vi.mocked(api.assistProjectForgeIssue).mock.calls.length > 0);
    await typeInto(textarea, "Typed meanwhile.");
    await act(async () => {
      finishDraft({ kind: "reply", text: "Thanks for the report." });
    });

    await waitFor(() => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')?.value.includes("Thanks"));
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')?.value).toBe("Typed meanwhile.\n\nThanks for the report.");
  });

  it("opens one chat when the shortcut is pressed twice", async () => {
    const api = createApi(tokenAccess);
    const { container, handlers } = await renderIssues(api);
    await click(await waitFor(() => findButtonContaining("Default test runs must be headless")));
    await waitFor(() => text(container).includes("Tests open a visible window."));
    await click(findButton("Ask")!);
    const question = await waitFor(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Question"]'));

    await act(async () => {
      question.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      question.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });

    await waitFor(() => handlers.onAskIssue.mock.calls.length > 0);
    expect(handlers.onAskIssue).toHaveBeenCalledOnce();
  });

  it("prompts for a token when the repository's issues are not public", async () => {
    const api = createApi(anonymousAccess, {
      listProjectForgeIssues: vi.fn(async () =>
        listResult(anonymousAccess, { items: [], unavailable: { reason: "needs-token", message: "GitHub does not show this repository's issues without signing in.", retryAt: null } }),
      ),
    });
    const { container, handlers } = await renderIssues(api);

    await waitFor(() => text(container).includes("Issues need a hosting token"));
    await click(findButton("Open Project Settings")!);
    expect(handlers.onOpenProjectSettings).toHaveBeenCalledOnce();
  });

  it("starts one run per checked issue from the batch bar", async () => {
    const api = createApi(tokenAccess);
    const { container, handlers } = await renderIssues(api);
    await waitFor(() => findButtonContaining("Default test runs must be headless"));

    for (const checkbox of Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) await click(checkbox);
    await click(await waitFor(() => findButton("Start runs")));
    await click(await waitFor(() => findButton("Start 2 runs")));

    await waitFor(() => handlers.onStartIssueRuns.mock.calls.length > 0);
    const [requests] = handlers.onStartIssueRuns.mock.calls[0] as unknown as [Array<{ issue: { number: number } }>];
    expect(requests.map((request) => request.issue.number)).toEqual([183, 141]);
    expect(api.getProjectForgeIssueDetails).toHaveBeenCalledTimes(2);
  });

  it("filters from the list column: state as a switch, the rest behind one Filters button", async () => {
    const api = createApi(tokenAccess, {
      getProjectForgeIssueMetadata: vi.fn(async () => ({ labels: [{ name: "bug", color: "d73a4a", description: null }], milestones: [], assignees: [], templates: [], warnings: [] })),
    });
    const { container } = await renderIssues(api);
    await waitFor(() => findButtonContaining("Default test runs must be headless"));
    const listCalls = () => vi.mocked(api.listProjectForgeIssues).mock.calls.map(([, input]) => input);

    const stateSwitch = container.querySelector('[role="group"][aria-label="Issue state"]')!;
    await click(Array.from(stateSwitch.querySelectorAll<HTMLButtonElement>("button")).find((button) => text(button) === "Closed")!);
    await waitFor(() => listCalls().some((input) => input?.state === "closed"));

    // Labels are fetched only once the panel is opened.
    expect(api.getProjectForgeIssueMetadata).not.toHaveBeenCalled();
    await click(await waitFor(() => findButton("Filters")));
    expect(api.getProjectForgeIssueMetadata).toHaveBeenCalledOnce();
    await click(await waitFor(() => findButtonContaining("Labels")));
    await click(await waitFor(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((option) => text(option) === "bug")));
    await waitFor(() => listCalls().some((input) => input?.state === "closed" && input.labels?.join() === "bug"));

    // The active filter shows as a chip under the switch and can be removed there.
    const callsBefore = listCalls().length;
    await click(await waitFor(() => container.querySelector<HTMLButtonElement>('button[aria-label="Remove the filter bug"]')));
    await waitFor(() => listCalls().length > callsBefore);
    expect(listCalls().at(-1)).toMatchObject({ state: "closed", labels: [] });
    expect(container.querySelector('button[aria-label="Remove the filter bug"]')).toBeNull();
  });

  it("moves through a picker list with the arrow keys, with one option as the tab stop", async () => {
    const names = ["bug", "docs", "feature", "infra", "perf", "question", "security", "ux"];
    const api = createApi(tokenAccess, {
      getProjectForgeIssueMetadata: vi.fn(async () => ({
        labels: names.map((name) => ({ name, color: null, description: null })),
        milestones: [],
        assignees: [],
        templates: [],
        warnings: [],
      })),
    });
    await renderIssues(api);
    await click(await waitFor(() => findButton("Filters")));
    await click(await waitFor(() => findButtonContaining("Labels")));
    const filter = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Filter labels"]'));
    const options = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="Labels"] [role="option"]'));
    const press = async (key: string) => {
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    };
    const focused = () => (document.activeElement ? text(document.activeElement) : "");

    expect(options().map((option) => option.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1]);
    await act(async () => filter.focus());
    await press("ArrowDown");
    expect(focused()).toBe("bug");
    await press("ArrowDown");
    expect(focused()).toBe("docs");
    expect(options().map((option) => option.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1, -1]);
    await press("End");
    expect(focused()).toBe("ux");
    await press("ArrowDown");
    expect(focused()).toBe("ux");
    await press("Home");
    expect(focused()).toBe("bug");
    // Up from the first option goes back to the filter field.
    await press("ArrowUp");
    expect(document.activeElement).toBe(filter);
  });

  it("names the third sort order after what GitLab really sorts by", async () => {
    const api = createApi(tokenAccess, { listProjectForgeIssues: vi.fn(async () => listResult(tokenAccess, { provider: "gitlab" })) });
    await renderIssues(api);
    await click(await waitFor(() => findButton("Filters")));

    const sortButtons = await waitFor(() => document.querySelector('[role="group"][aria-label="Sort issues"]'));
    expect(Array.from(sortButtons.querySelectorAll("button")).map(text)).toEqual(["Updated", "Newest", "Upvotes"]);
  });

  it("loads pictures from the Git host through the app and keeps asking for other hosts", async () => {
    const picture = "https://github.com/user-attachments/assets/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const api = createApi(tokenAccess, {
      getProjectForgeIssueDetails: vi.fn(async (_projectId: string, input: { issueNumber: number }) => {
        const result = detailsResult(tokenAccess, input.issueNumber);
        return { ...result, issue: { ...result.issue, body: `Screenshot:\n\n![Shot](${picture})\n\n![Badge](https://img.example.com/badge.png)` } };
      }),
      getProjectForgeIssueImage: vi.fn(async () => ({ dataUrl })),
    });
    const { container } = await renderIssues(api);
    await click(await waitFor(() => findButtonContaining("Default test runs must be headless")));

    const image = await waitFor(() => container.querySelector<HTMLImageElement>('img[alt="Shot"]'));
    expect(image.getAttribute("src")).toBe(dataUrl);
    expect(api.getProjectForgeIssueImage).toHaveBeenCalledWith(expect.any(String), { url: picture, issueNumber: 183 });
    expect(findButtonContaining("Load image from img.example.com")).toBeTruthy();
    expect(api.getProjectForgeIssueImage).toHaveBeenCalledOnce();
  });
});

describe("ProjectForgeTab", () => {
  it("keeps pull requests and issues behind one switch and loads issues on first use", async () => {
    const api = createApi(anonymousAccess);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    await act(async () => {
      root.render(
        <BuildWardenClientProvider client={createElectronBuildWardenClient(api)}>
          <ProjectForgeTab
            projectId="project-forge-1"
            baseBranch="main"
            runs={[]}
            tasks={[]}
            chats={[]}
            modelOptions={[]}
            defaultModelId=""
            preferences={EMPTY_PROJECT_FORGE_ISSUE_PREFERENCES}
            onOpenProjectSettings={vi.fn()}
            onSavePreferences={vi.fn(async () => {})}
            onStartIssueRuns={vi.fn(async () => {})}
            onAskIssue={vi.fn(async () => {})}
            onWorkChanged={vi.fn()}
            onSelectRun={vi.fn()}
            onOpenChat={vi.fn()}
            onOpenTaskBoard={vi.fn()}
          />
        </BuildWardenClientProvider>,
      );
    });

    const switcher = await waitFor(() => container.querySelector('[role="tablist"][aria-label="Pull requests or issues"]'));
    expect(text(switcher)).toBe("Pull requestsIssues");
    expect(api.listProjectForgeIssues).not.toHaveBeenCalled();

    await click(Array.from(switcher.querySelectorAll<HTMLButtonElement>("button")).find((button) => text(button).startsWith("Issues"))!);
    await waitFor(() => findButtonContaining("Connection HUD omits battery levels"));
    expect(api.listProjectForgeIssues).toHaveBeenCalledOnce();
    // The count of loaded issues appears on the switch of both views.
    expect(Array.from(container.querySelectorAll('[role="tablist"][aria-label="Pull requests or issues"]')).map(text)).toEqual(["Pull requestsIssues2", "Pull requestsIssues2"]);
  });
});
