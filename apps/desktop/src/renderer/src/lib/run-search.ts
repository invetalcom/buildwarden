export interface RunSearchFields {
  prompt: string;
  goalText?: string | null;
  userInputSearchText?: string;
}

export const parseSearchTerms = (value: string) =>
  value
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

export const runMatchesSearch = (run: RunSearchFields, terms: string[]) => {
  if (terms.length === 0) return true;
  const searchText = (run.userInputSearchText ?? [run.prompt, run.goalText ?? ""].join("\n")).toLocaleLowerCase();
  return terms.every((term) => searchText.includes(term));
};
