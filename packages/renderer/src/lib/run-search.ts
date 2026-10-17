export interface RunSearchFields {
  id?: string;
  prompt: string;
  goalText?: string | null;
}

export const parseSearchTerms = (value: string) =>
  value
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

/**
 * Matches the prompt and goal locally. Follow-up prompts and submitted answers
 * are not part of snapshots; pass the ids returned by `searchRunUserInput` as
 * `userInputMatches` to include runs that match on those.
 */
export const runMatchesSearch = (
  run: RunSearchFields,
  terms: string[],
  userInputMatches?: ReadonlySet<string> | null,
) => {
  if (terms.length === 0) return true;
  if (run.id && userInputMatches?.has(run.id)) return true;
  const searchText = [run.prompt, run.goalText ?? ""].join("\n").toLocaleLowerCase();
  return terms.every((term) => searchText.includes(term));
};
