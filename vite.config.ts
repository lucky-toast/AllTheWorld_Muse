import { defineConfig } from "vitest/config";
import { storagePlugin } from "./devserver/storage";
import { aiPlugin } from "./devserver/ai";
import { sdkRefPlugin } from "./devserver/sdkref";
import { rawBinaryenPlugin } from "./devserver/rawdeps";

export default defineConfig({
  plugins: [storagePlugin(), aiPlugin(), sdkRefPlugin(), rawBinaryenPlugin()],
  // The AssemblyScript compiler and binaryen use top-level await: build for ES2022 and serve them unbundled in dev.
  build: { target: "es2022" },
  optimizeDeps: { exclude: ["assemblyscript", "binaryen"] },
  worker: { format: "es" },
  // Saved systems and the world live in data/; writing them must never reload the page.
  server: { watch: { ignored: ["**/data/**"] } },
  test: { include: ["tests/**/*.test.ts"], globals: true },
});
