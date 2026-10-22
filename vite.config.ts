import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "web/src") },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        // Split heavy vendors into long-cacheable chunks — shiki alone is the
        // bulk of the bundle, xterm/dnd follow. App code stays in the entry.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (id.includes("shiki") || id.includes("@shikijs") || id.includes("vscode-textmate") || id.includes("oniguruma")) return "shiki";
          if (id.includes("@xterm")) return "xterm";
          if (id.includes("@dnd-kit")) return "dnd";
          if (id.includes("react-dom") || id.includes("react-router") || /node_modules[\\/]react[\\/]/.test(id) || id.includes("scheduler")) return "react";
          if (id.includes("i18next")) return "i18n";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7781",
      "/ws": { target: "ws://localhost:7781", ws: true },
    },
  },
});
