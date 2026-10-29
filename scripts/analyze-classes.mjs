import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(path.join(repositoryRoot, "apps", "desktop", "package.json"));
const ts = desktopRequire("typescript");
const classes = [];

for (const root of ["apps", "packages"]) {
  const files = ts.sys.readDirectory(path.join(repositoryRoot, root), [".ts", ".tsx"], [
    "**/node_modules/**", "**/out/**", "**/dist/**", "**/build/**", "**/release/**", "**/coverage/**",
    "**/*.test.ts", "**/*.test.tsx", "**/*.d.ts",
  ], ["**/src/**/*"]);
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const endLine = source.getLineAndCharacterOfPosition(node.end).line + 1;
        classes.push({
          name: node.name?.text ?? "(anonymous)",
          file: path.relative(repositoryRoot, file),
          line,
          lines: endLine - line + 1,
          methods: node.members.filter(ts.isMethodDeclaration).length,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

classes.sort((left, right) => right.lines - left.lines || left.file.localeCompare(right.file));
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ classes, oversizedClasses: classes.filter((entry) => entry.lines > 600) }));
} else {
  console.log("Largest production classes (physical lines, including comments and blanks):");
  console.table(classes.slice(0, 20));
  console.log(`${classes.filter((entry) => entry.lines > 600).length} classes exceed 600 lines. Review responsibilities before splitting.`);
}
