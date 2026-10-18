/** Host-specific visualization tokens are not executable HTML in BuildWarden.
 * Keep a readable source-file reference, including for older saved responses.
 */
export const normalizeResponseArtifactReferences = (content: string): string => content.replace(
  /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)|\uE200visualize\uE202([^\uE201]+)\uE201/g,
  (match: string, code: string | undefined, payload: string) => {
    if (code) return match;
    try {
      const value: unknown = JSON.parse(payload);
      if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string") return "Visualization unavailable.";
      let path = value.path.replace(/\\/g, "/");
      if (!/\.html?$/i.test(path) || /[\r\n]/.test(path) || path.startsWith("//") ||
        (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:\//i.test(path))) return "Visualization unavailable.";
      // A leading slash keeps Windows paths valid Markdown URLs; the workspace
      // file viewer already maps /C:/... back to C:/... and enforces containment.
      if (/^[a-z]:\//i.test(path)) path = `/${path}`;
      const destination = path.replace(/[%<>#?\s]/g, (character) => encodeURIComponent(character));
      return `[Visualization source (HTML)](<${destination}>)`;
    } catch {
      return "Visualization unavailable.";
    }
  },
);
