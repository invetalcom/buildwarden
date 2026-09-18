import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["node_modules", "dist"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
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
      // Preserve the existing Hooks checks; React Compiler adoption is separate.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // ESLint 10 added these to recommended; retain the previous lint policy.
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    // The mobile UI must never reuse desktop templates. Presentation-free logic is shared through
    // the `@buildwarden/renderer/logic` entry point; components and styles are not shareable.
    files: ["src/mobile/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@buildwarden/renderer/src/components/*",
                "@buildwarden/renderer/src/App*",
                "@buildwarden/renderer/styles.css",
                "**/packages/renderer/src/components/*",
              ],
              message:
                "The mobile UI owns its own components and styles. Share presentation-free logic through '@buildwarden/renderer/logic' instead.",
            },
          ],
        },
      ],
    },
  },
);
