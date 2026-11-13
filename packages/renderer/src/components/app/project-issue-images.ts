/** Resolves an image of an issue to a data URL the page may show. */
export type IssueImageLoader = (url: string, issueNumber: number) => Promise<string>;

/**
 * Loads issue images through the host, a few at a time, and remembers the most recent ones
 * so reopening an issue does not download its screenshots again.
 */
export const createIssueImageLoader = (
  fetchImage: IssueImageLoader,
  limits: { parallel: number; remembered: number } = { parallel: 4, remembered: 48 },
): IssueImageLoader => {
  const remembered = new Map<string, Promise<string>>();
  const waiting: Array<() => void> = [];
  let active = 0;

  const acquire = (): Promise<void> => {
    if (active < limits.parallel) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  /** A finished download hands its slot straight to the next one waiting. */
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return (url, issueNumber) => {
    const known = remembered.get(url);
    if (known) {
      remembered.delete(url);
      remembered.set(url, known);
      return known;
    }
    const pending = acquire().then(() => fetchImage(url, issueNumber).finally(release));
    remembered.set(url, pending);
    // A failed download is not remembered, so reloading the issue tries again.
    pending.catch(() => {
      if (remembered.get(url) === pending) remembered.delete(url);
    });
    while (remembered.size > limits.remembered) {
      const oldest = remembered.keys().next().value;
      if (oldest === undefined) break;
      remembered.delete(oldest);
    }
    return pending;
  };
};
