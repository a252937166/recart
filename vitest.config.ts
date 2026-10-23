import path from "node:path";
import { defineConfig } from "vitest/config";

// RECART_IMPL_DIR=<compiled tree, e.g. dist/server> runs the tests against compiled modules instead of the sources:
// every import of src/<area>/... (test files and harness alike) resolves into that tree, so each module loads once.
const impl = process.env.RECART_IMPL_DIR ? path.resolve(process.env.RECART_IMPL_DIR) : null;

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30000, hookTimeout: 60000, pool: "forks", fileParallelism: false },
  ...(impl ? { resolve: { alias: [{ find: /^(?:\.\.\/)+src\/(server|domain|platform|shared)\/(.*)$/, replacement: `${impl}/$1/$2` }] } } : {}),
});
