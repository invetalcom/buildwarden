import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const desktopPackage = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
  releaseDate?: string;
};

export default defineConfig({
  root: resolve(__dirname, "src/renderer/web"),
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(__dirname, "out/web"),
    emptyOutDir: true,
    reportCompressedSize: false,
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(desktopPackage.version),
    "import.meta.env.VITE_APP_VERSION_DATE": JSON.stringify(desktopPackage.releaseDate ?? ""),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
      "@buildwarden/shared": resolve(__dirname, "../../packages/shared/src"),
    },
  },
});
