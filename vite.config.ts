import { defineConfig } from "vite-plus";

const generated = ["**/worker-configuration.d.ts", "apps/hive/seed/**"];

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    printWidth: 120,
    ignorePatterns: generated,
  },
  lint: {
    ignorePatterns: generated,
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
