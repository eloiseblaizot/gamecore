import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packages = fileURLToPath(new URL("./packages/", import.meta.url));

export default defineConfig({
  resolve: {
    // Les tests importent les paquets `@gamecore/*` depuis leurs sources :
    // aucun build n'est nécessaire avant `pnpm test`.
    alias: [
      { find: /^@gamecore\/([a-z-]+)$/, replacement: `${packages}$1/src/index.ts` },
      { find: /^@gamecore\/([a-z-]+)\/([a-z-]+)$/, replacement: `${packages}$1/src/$2.ts` },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "examples/*/src/**/*.test.{ts,tsx}"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/index.ts", "**/__fixtures__/**"],
      reporter: ["text", "html"],
      // Seuils minimaux : le CI échoue si la couverture régresse sous ces valeurs.
      thresholds: { statements: 80, branches: 70, functions: 75, lines: 80 },
    },
  },
});
