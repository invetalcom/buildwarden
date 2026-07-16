import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const desktopPackage = JSON.parse(readFileSync(resolve(__dirname, "../desktop/package.json"), "utf8")) as {
  version: string;
  releaseDate?: string;
};

export default defineConfig(({ mode }) => {
  const webMode = mode === "embedded" ? "embedded" : "hosted";
  return {
    base: "/",
    plugins: [react(), tailwindcss()],
    build: {
      outDir: webMode === "embedded" ? resolve(__dirname, "../desktop/out/web") : resolve(__dirname, "dist"),
      emptyOutDir: true,
      reportCompressedSize: false,
    },
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(desktopPackage.version),
      "import.meta.env.VITE_APP_VERSION_DATE": JSON.stringify(desktopPackage.releaseDate ?? ""),
      "import.meta.env.VITE_WEB_MODE": JSON.stringify(webMode),
    },
  };
});
