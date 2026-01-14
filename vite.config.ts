import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "./",
  server: {
    port: 5173,
    open: true,
    strictPort: false,
    hmr: {
      host: "localhost",
      protocol: "ws"
    }
  }
});
