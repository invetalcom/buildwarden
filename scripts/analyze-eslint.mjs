import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(path.join(repositoryRoot, "apps", "desktop", "package.json"));
const { ESLint } = desktopRequire("eslint");
const tseslint = desktopRequire("typescript-eslint");
const sonarjs = desktopRequire("eslint-plugin-sonarjs");
const reactHooks = desktopRequire("eslint-plugin-react-hooks");
const reactRefreshModule = desktopRequire("eslint-plugin-react-refresh");
const reactRefresh = reactRefreshModule.default ?? reactRefreshModule;

const eslint = new ESLint({
  cwd: repositoryRoot,
  overrideConfigFile: true,
  overrideConfig: [
    {
      ignores: ["**/build/**", "**/dist/**", "**/node_modules/**", "**/out/**", "**/release/**"],
    },
    sonarjs.configs.recommended,
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          project: [path.join(repositoryRoot, "apps", "desktop", "tsconfig.json")],
          tsconfigRootDir: repositoryRoot,
        },
      },
      plugins: {
        "@typescript-eslint": tseslint.plugin,
        "react-hooks": reactHooks,
        "react-refresh": reactRefresh,
      },
      rules: {
        ...reactHooks.configs.recommended.rules,
        "@typescript-eslint/no-explicit-any": "error",
        "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
        "sonarjs/cognitive-complexity": ["warn", 15],
        "max-lines": ["warn", { max: 600, skipBlankLines: true, skipComments: true }],
        "max-lines-per-function": ["warn", { max: 200, skipBlankLines: true, skipComments: true }],
      },
    },
    {
      files: ["**/*.test.{ts,tsx}"],
      rules: {
        "max-lines-per-function": "off",
        "sonarjs/no-duplicate-string": "off",
      },
    },
  ],
});

const results = await eslint.lintFiles(["apps/desktop/**/*.{ts,tsx}", "packages/**/*.ts"]);
const findings = results.flatMap((result) =>
  result.messages.map((message) => ({
    file: path.relative(repositoryRoot, result.filePath),
    line: message.line,
    message: message.message,
    rule: message.ruleId ?? "parser",
    severity: message.severity,
  })),
);

const byRule = Object.entries(Object.groupBy(findings, (finding) => finding.rule))
  .map(([rule, entries]) => ({ rule, count: entries.length }))
  .sort((left, right) => right.count - left.count || left.rule.localeCompare(right.rule));
const complexityHotspots = findings
  .filter((finding) => finding.rule === "sonarjs/cognitive-complexity")
  .map((finding) => ({
    ...finding,
    score: Number(/from (\d+) to/.exec(finding.message)?.[1] ?? 0),
  }))
  .sort((left, right) => right.score - left.score)
  .slice(0, 15);

console.log(`Analyzed ${results.length} files; ${findings.length} findings (${findings.filter((item) => item.severity === 2).length} errors, ${findings.filter((item) => item.severity === 1).length} warnings).`);
console.table(byRule);
const parserFindings = findings.filter((finding) => finding.rule === "parser");
if (parserFindings.length > 0) {
  console.log("Parser findings:");
  console.table(parserFindings.map(({ file, line, message }) => ({ file, line, message })));
}
if (complexityHotspots.length > 0) {
  console.log("Highest cognitive-complexity findings:");
  console.table(complexityHotspots.map(({ file, line, score }) => ({ score, file, line })));
}

if (process.argv.includes("--strict") && findings.length > 0) {
  process.exitCode = 1;
}
