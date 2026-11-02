import { defineConfig } from "vitest/config";
import { storagePlugin } from "./devserver/storage";

export default defineConfig({
  plugins: [storagePlugin()],
  // The AssemblyScript compiler and binaryen use top-level await: build for ES2022 and serve them unbundled in dev.
  build: { target: "es2022" },
  optimizeDeps: { exclude: ["assemblyscript", "binaryen"] },
  worker: { format: "es" },
  test: { include: ["tests/**/*.test.ts"], globals: true },
});
