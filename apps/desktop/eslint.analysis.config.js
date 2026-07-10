// Code-quality analysis config (SonarJS). Not part of the CI lint gate;
// run with: npx eslint --config eslint.analysis.config.js <paths>
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  {
    ignores: ["dist", "dist-release", "node_modules", "out", "release", "build"],
  },
  sonarjs.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "sonarjs/cognitive-complexity": ["warn", 15],
      "max-lines": ["warn", { max: 600, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "max-lines-per-function": "off",
      "sonarjs/no-duplicate-string": "off",
    },
  },
);
