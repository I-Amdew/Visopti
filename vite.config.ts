import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "./",
  server: {
    port: 5173,
    open: true,
    strictPort: true,
    hmr: {
      host: "localhost",
      protocol: "ws",
      clientPort: 5173
    }
  }
});
