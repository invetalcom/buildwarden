import { describe, expect, it } from "vitest";
import { parseProjectInsightAiResponse, parseRecentCommitLog } from "./project-insights";

describe("project insight responses", () => {
  it.each(["null", "[]", "42", '"text"', "not JSON"])("defaults safely for %s", (raw) => {
    expect(parseProjectInsightAiResponse("repo-historian", raw)).toEqual({
      title: "Repo historian",
      summary: "Repository history summary generated.",
      data: { synopsis: "No synopsis returned.", sections: [], notableCommits: [] },
    });
  });

  it("normalizes historian text and discards incomplete entries", () => {
    const result = parseProjectInsightAiResponse("repo-historian", JSON.stringify({
      title: " History ", summary: " Changes ", synopsis: " Evolving ",
      sections: [null, [], { title: " Missing detail " }, { title: " API ", detail: " Simplified " }],
      notableCommits: [{ sha: " abc ", title: " Refactor ", author: 12 }, { title: "No SHA" }],
    }));
    expect(result).toEqual({
      title: "History", summary: "Changes",
      data: {
        synopsis: "Evolving", sections: [{ title: "API", detail: "Simplified" }],
        notableCommits: [{ sha: "abc", title: "Refactor", author: "", date: "" }],
      },
    });
  });

  it("bounds mood scores and normalizes optional file paths", () => {
    const result = parseProjectInsightAiResponse("codebase-mood", JSON.stringify({
      overallScore: 120,
      sections: [{ label: " Tests ", score: -5, summary: " Add cases " }, { label: "Invalid" }],
      findings: [{ title: " Coverage ", detail: " Missing paths ", filePath: " " }, false],
      nextMoves: [" Test failures ", null, ""],
    }));
    expect(result.data).toEqual({
      overallScore: 100, posture: "Mixed",
      sections: [{ label: "Tests", score: 0, summary: "Add cases" }],
      findings: [{ title: "Coverage", detail: "Missing paths", filePath: null }],
      nextMoves: ["Test failures"],
    });
  });

  it("filters malformed curiosity evidence and suggestions", () => {
    const result = parseProjectInsightAiResponse("curiosity-mode", JSON.stringify({
      themes: [{ title: " Coupling ", whyItMatters: " Risk ", evidence: [" Imports ", 1] }, {}],
      suggestedPrompts: [" Explore imports ", false],
    }));
    expect(result.data).toEqual({
      themes: [{ title: "Coupling", whyItMatters: "Risk", evidence: ["Imports"] }],
      suggestedPrompts: ["Explore imports"],
    });
  });

  it("retains commit ordering and normalizes source paths", () => {
    const commits = parseRecentCommitLog([
      "__EC__\tabc\tAlex\t2026-10-01\tUpdate shared logic",
      "src\\shared.ts", "", "__EC__\tdef\tSam\t2026-09-30\tInitial version", "src/app.ts",
    ].join("\n"));
    expect(commits.map((commit) => [commit.sha, commit.files])).toEqual([
      ["abc", ["src/shared.ts"]], ["def", ["src/app.ts"]],
    ]);
  });
});
