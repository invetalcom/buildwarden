import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coveragePath = path.join(repositoryRoot, "apps", "desktop", "coverage", "coverage-summary.json");
const duplicateReportDirectory = path.join(repositoryRoot, ".quality-score-temp");
const duplicateReportPath = path.join(duplicateReportDirectory, "jscpd-report.json");

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const round = (value) => Math.round(value * 10) / 10;

const coverage = JSON.parse(readFileSync(coveragePath, "utf8")).total;
const analysis = JSON.parse(
  execFileSync(process.execPath, [path.join(repositoryRoot, "scripts", "analyze-eslint.mjs"), "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }),
);

try {
  const jscpdArguments = [
    "exec",
    "jscpd",
    "--config",
    ".jscpd.json",
    "--reporters",
    "json",
    "--output",
    duplicateReportDirectory,
    "apps",
    "packages",
  ];
  if (process.env.npm_execpath) {
    execFileSync(process.execPath, [process.env.npm_execpath, ...jscpdArguments], { cwd: repositoryRoot, stdio: "ignore" });
  } else if (process.platform === "win32") {
    execFileSync(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "pnpm", ...jscpdArguments], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } else {
    execFileSync("pnpm", jscpdArguments, { cwd: repositoryRoot, stdio: "ignore" });
  }
  const duplication = JSON.parse(readFileSync(duplicateReportPath, "utf8")).statistics.total;
  const linesOfCode = Math.max(1, duplication.lines);
  const findingsPerKloc = analysis.totalFindings / (linesOfCode / 1000);
  const oversizedFunctions = analysis.byRule["max-lines-per-function"] ?? 0;
  const oversizedFiles = analysis.byRule["max-lines"] ?? 0;
  const staticRiskFindings =
    (analysis.byRule["sonarjs/no-os-command-from-path"] ?? 0) +
    (analysis.byRule["sonarjs/super-linear-regex"] ?? 0) +
    (analysis.byRule["sonarjs/regex-complexity"] ?? 0) +
    (analysis.byRule["sonarjs/pseudo-random"] ?? 0);

  const categories = {
    buildHealth: 20,
    testSafety:
      10 * clamp(coverage.lines.pct / 60, 0, 1) +
      10 * clamp(coverage.branches.pct / 50, 0, 1),
    maintainability: clamp(25 - analysis.totalFindings / 30 - (analysis.byRule["sonarjs/cognitive-complexity"] ?? 0) / 30, 0, 25),
    architecture: clamp(
      15 - analysis.highestCognitiveComplexity / 30 - oversizedFunctions / 15 - oversizedFiles / 20,
      0,
      15,
    ),
    duplication: clamp(10 * (1 - duplication.percentage / 20), 0, 10),
    hygiene: 5,
    staticRisk: clamp(5 - staticRiskFindings / 7.5, 0, 5),
  };
  const total = Object.values(categories).reduce((sum, value) => sum + value, 0);
  const report = {
    score: round(total),
    grade: total >= 90 ? "A" : total >= 80 ? "B" : total >= 70 ? "C" : total >= 60 ? "D" : "E",
    categories: Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, round(value)])),
    metrics: {
      coverage: { lines: coverage.lines.pct, branches: coverage.branches.pct, functions: coverage.functions.pct },
      findings: analysis.totalFindings,
      cognitiveComplexityFindings: analysis.byRule["sonarjs/cognitive-complexity"] ?? 0,
      highestCognitiveComplexity: analysis.highestCognitiveComplexity,
      findingsPerKloc: round(findingsPerKloc),
      duplicationPercent: round(duplication.percentage),
      duplicatedLines: duplication.duplicatedLines,
      staticRiskFindings,
    },
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(duplicateReportDirectory, { recursive: true, force: true });
}
