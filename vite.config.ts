import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("./dist/web", import.meta.url)), emptyOutDir: true, sourcemap: false },
  server: { port: 5180, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:4060", changeOrigin: false } } },
});
