import { defineConfig } from "tsup";

/**
 * Worker bundle: compiles src/workers/index.ts (and everything it imports via
 * the @/ alias) into dist/workers/index.js. Runtime dependencies stay external
 * and are installed in the image's node_modules.
 */
export default defineConfig({
  entry: { "workers/index": "src/workers/index.ts" },
  outDir: "dist",
  format: ["cjs"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  splitting: false,
  // Bundle our own code; keep every npm package external.
  skipNodeModulesBundle: true,
  tsconfig: "tsconfig.json",
});
