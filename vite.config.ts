import { defineConfig } from "vitest/config";
import { storagePlugin } from "./devserver/storage";

export default defineConfig({
  plugins: [storagePlugin()],
  test: { include: ["tests/**/*.test.ts"], globals: true },
});
