import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { fileURLToPath } from "node:url";
const host = process.env.TAURI_DEV_HOST;
const monacoEsm = fileURLToPath(new URL("./node_modules/monaco-editor/esm/vs/", import.meta.url));

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  // Styles internes de Monaco, non exposés par son champ `exports` (voir src/lib/monaco-editor.ts).
  resolve: { alias: [{ find: /^monaco-esm\//, replacement: monacoEsm.replaceAll("\\", "/") }] },
  // Monaco est chargé à la demande depuis ses modules ESM (sous-ensemble) : pas de pré-optimisation,
  // qui en créerait une seconde copie.
  optimizeDeps: { include: ["@monaco-editor/react"], exclude: ["monaco-editor"] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
