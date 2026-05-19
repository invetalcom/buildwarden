import { readFileSync } from "node:fs";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const desktopPkgPath = resolve(__dirname, "package.json");
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, "utf-8")) as {
  version: string;
  releaseDate?: string;
};
const appVersionDate =
  typeof desktopPkg.releaseDate === "string" && desktopPkg.releaseDate.trim()
    ? desktopPkg.releaseDate.trim()
    : new Date().toISOString().slice(0, 10);

const internalPackages = [
  "@easycode/shared",
  "@easycode/db",
  "@easycode/git-service",
  "@easycode/agent-runtime",
  "@easycode/provider-ai-sdk",
  "@easycode/provider-claude-code",
  "@easycode/provider-codex-cli",
  "@easycode/provider-azure-legacy",
  // Bundle simple-git so its transitive deps (@kwsites/file-exists, etc.) are included in the packaged app
  "simple-git",
];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: internalPackages,
      },
      rollupOptions: {
        external: ["node-pty"],
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          worker: resolve(__dirname, "src/main/run-worker.ts"),
          "chat-worker": resolve(__dirname, "src/main/chat-worker.ts"),
          "git-diff-worker": resolve(__dirname, "src/main/git-diff-worker.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@easycode/shared": resolve(__dirname, "../../packages/shared/src"),
        "@easycode/db": resolve(__dirname, "../../packages/db/src"),
        "@easycode/git-service": resolve(__dirname, "../../packages/git-service/src"),
        "@easycode/agent-runtime": resolve(__dirname, "../../packages/agent-runtime/src"),
        "@easycode/provider-ai-sdk": resolve(__dirname, "../../packages/provider-ai-sdk/src"),
        "@easycode/provider-claude-code": resolve(__dirname, "../../packages/provider-claude-code/src"),
        "@easycode/provider-codex-cli": resolve(__dirname, "../../packages/provider-codex-cli/src"),
        "@easycode/provider-azure-legacy": resolve(__dirname, "../../packages/provider-azure-legacy/src"),
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      externalizeDeps: {
        exclude: internalPackages,
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@easycode/shared": resolve(__dirname, "../../packages/shared/src"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(desktopPkg.version),
      "import.meta.env.VITE_APP_VERSION_DATE": JSON.stringify(appVersionDate),
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@easycode/shared": resolve(__dirname, "../../packages/shared/src"),
      },
    },
  },
});
