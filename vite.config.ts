import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  staged: { "*.{ts,js,json,md,yml}": "vp check --fix" },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["src/**/*.test.ts", "doc/reports/examples/**/*.test.ts"],
    // Measured 2026-11-14 (#383): the slowest tests take 0.6-1.3s on an Apple-silicon laptop,
    // and Windows CI runners are about 5x slower (#342: 1.1s locally, over 5s on Windows), so
    // the 5s default failed required CI on unrelated PRs. 20s gives every test at least 3x
    // headroom on Windows while still catching real hangs.
    testTimeout: 20_000,
  },
});
