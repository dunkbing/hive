import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

// https://vite.dev/config/
export default defineConfig({
  lint: {
    plugins: ["react", "typescript", "oxc"],
    ignorePatterns: ["seed/**", "worker-configuration.d.ts"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
        },
      ],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  plugins: lazyPlugins(() => [
    react(),
    cloudflare({
      // Checks run in containers, which need Docker locally. Without HIVE_DEV_CONTAINERS=1 they are reported as
      // skipped in development; deployed Workers always run them.
      config: (config) => ({
        dev: { ...config.dev, enable_containers: process.env.HIVE_DEV_CONTAINERS === "1" },
      }),
    }),
  ]),
});
