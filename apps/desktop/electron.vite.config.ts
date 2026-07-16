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
  "@buildwarden/shared",
  "@buildwarden/db",
  "@buildwarden/git-service",
  "@buildwarden/agent-runtime",
  "@buildwarden/provider-ai-sdk",
  "@buildwarden/provider-claude-code",
  "@buildwarden/provider-codex-cli",
  "@buildwarden/provider-cursor-agent",
  "@buildwarden/provider-azure-legacy",
  "@buildwarden/remote-server",
  // Bundle simple-git so its transitive deps (@kwsites/file-exists, etc.) are included in the packaged app
  "simple-git",
];

export default defineConfig({
  main: {
    build: {
      reportCompressedSize: false,
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
        "@buildwarden/shared": resolve(__dirname, "../../packages/shared/src"),
        "@buildwarden/db": resolve(__dirname, "../../packages/db/src"),
        "@buildwarden/git-service": resolve(__dirname, "../../packages/git-service/src"),
        "@buildwarden/agent-runtime": resolve(__dirname, "../../packages/agent-runtime/src"),
        "@buildwarden/provider-ai-sdk": resolve(__dirname, "../../packages/provider-ai-sdk/src"),
        "@buildwarden/provider-claude-code": resolve(__dirname, "../../packages/provider-claude-code/src"),
        "@buildwarden/provider-codex-cli": resolve(__dirname, "../../packages/provider-codex-cli/src"),
        "@buildwarden/provider-cursor-agent": resolve(__dirname, "../../packages/provider-cursor-agent/src"),
        "@buildwarden/provider-azure-legacy": resolve(__dirname, "../../packages/provider-azure-legacy/src"),
        "@buildwarden/remote-server": resolve(__dirname, "../../packages/remote-server/src"),
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
        "@buildwarden/shared": resolve(__dirname, "../../packages/shared/src"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      reportCompressedSize: false,
    },
    server: {
      // Pre-transform the renderer module graph while the main process builds,
      // so the first window load does not pay the on-demand transform cost.
      warmup: {
        clientFiles: [resolve(__dirname, "src/renderer/src/main.tsx")],
      },
    },
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(desktopPkg.version),
      "import.meta.env.VITE_APP_VERSION_DATE": JSON.stringify(appVersionDate),
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@buildwarden/renderer": resolve(__dirname, "../../packages/renderer/src"),
        "@buildwarden/shared": resolve(__dirname, "../../packages/shared/src"),
      },
    },
  },
});
