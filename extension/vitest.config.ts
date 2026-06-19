import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 90_000,
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "src/test/vscodeMock.ts"),
    },
  },
});
