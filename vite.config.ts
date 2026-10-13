import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:5178" },
  },
});
