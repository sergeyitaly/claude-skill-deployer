import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "src/test/vscodeMock.ts"),
    },
  },
});
