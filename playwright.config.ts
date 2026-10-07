import { defineConfig, devices } from "@playwright/test";

/**
 * Tests de bout en bout : le jeu d'exemple est construit puis servi exactement comme en
 * production (un seul serveur Node : application + WebSockets), et piloté par de vrais
 * navigateurs — un écran d'hôte sur « PC » et des joueurs sur « téléphones » émulés.
 */
const PORT = 4173;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "fr-FR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter @gamecore/example-buzzer build && pnpm --filter @gamecore/example-buzzer start",
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      ALLOWED_ORIGINS: `http://localhost:${PORT}`,
      // Tous les navigateurs de test partagent l'adresse 127.0.0.1 : on relève les limites par IP.
      ROOMS_PER_MINUTE_PER_IP: "1000",
      FAILED_JOINS_PER_MINUTE: "1000",
    },
  },
});
