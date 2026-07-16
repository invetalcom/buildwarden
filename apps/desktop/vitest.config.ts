import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const packageSource = (packageName: string, fileName = "index.ts") =>
  fileURLToPath(new URL(`../../packages/${packageName}/src/${fileName}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@buildwarden/agent-runtime": packageSource("agent-runtime"),
      "@buildwarden/db": packageSource("db"),
      "@buildwarden/git-service": packageSource("git-service"),
      "@buildwarden/provider-ai-sdk": packageSource("provider-ai-sdk"),
      "@buildwarden/provider-azure-legacy": packageSource("provider-azure-legacy"),
      "@buildwarden/provider-claude-code": packageSource("provider-claude-code"),
      "@buildwarden/provider-codex-cli": packageSource("provider-codex-cli"),
      "@buildwarden/provider-cursor-agent": packageSource("provider-cursor-agent"),
      "@buildwarden/remote-server": packageSource("remote-server"),
      "@buildwarden/shared/integrated-skills-catalog": packageSource("shared", "integrated-skills-catalog.ts"),
      "@buildwarden/shared": packageSource("shared"),
    },
  },
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: [
        "src/main/**/*.ts",
        "src/preload/**/*.ts",
        "src/renderer/src/**/*.{ts,tsx}",
        "../../packages/*/src/**/*.ts"
      ],
      exclude: [
        "**/*.d.ts",
        "**/*.test.ts",
        "**/*.test.tsx",
        "../../packages/shared/src/integrated-skills-catalog.ts"
      ],
      thresholds: {
        statements: 26,
        branches: 18,
        functions: 20,
        lines: 26
      }
    }
  }
});
