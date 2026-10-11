/**
 * Exemple « Renards et lapins » (@gamecore/sim), de bout en bout : la simulation tourne dans
 * un vrai Web Worker de Chromium ; on vérifie la cadence, la pause, la sauvegarde
 * (téléchargement puis rechargement) et le rejeu déterministe.
 */

import { expect, test, type Page } from "@playwright/test";

/** Servi par `vite preview` (voir playwright.config.ts). */
const BASE = "http://localhost:4175";

const tickOf = async (page: Page) => Number(await page.getByTestId("tick").textContent());

/** Ouvre l'exemple (graine fixe) et attend que la simulation soit prête. */
async function open(page: Page, query = "seed=e2e"): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/?${query}`);
  await expect(page.getByRole("status")).toContainText("Simulation prête");
  return errors;
}

async function pause(page: Page): Promise<number> {
  const button = page.getByRole("button", { name: "Pause" });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  return tickOf(page);
}

test("la page se charge dans un Web Worker et les ticks avancent", async ({ page }) => {
  const errors = await open(page);
  await expect(page.getByRole("status")).toContainText("Web Worker");
  await expect.poll(() => tickOf(page)).toBeGreaterThan(10);
  await expect(page.getByTestId("rabbits")).toHaveText(/^\d+$/);
  await expect(page.getByTestId("tps")).not.toHaveText("0.0");
  // La politique de sécurité du contenu est en place, et rien ne l'a enfreinte.
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("script-src 'self'");
  expect(errors).toEqual([]);
});

test("la pause fige la simulation, le pas à pas avance d'un tick", async ({ page }) => {
  await open(page);
  await expect.poll(() => tickOf(page)).toBeGreaterThan(3);
  const paused = await pause(page);
  await page.waitForTimeout(1000);
  expect(await tickOf(page)).toBe(paused);
  await page.getByRole("button", { name: "Pas à pas" }).click();
  await expect(page.getByTestId("tick")).toHaveText(String(paused + 1));
  await page.getByRole("button", { name: "×4" }).click();
  await expect.poll(() => tickOf(page)).toBeGreaterThan(paused + 20);
});

test("sauvegarder puis recharger conserve le tick", async ({ page }) => {
  await open(page);
  await expect.poll(() => tickOf(page)).toBeGreaterThan(10);
  const saved = await pause(page);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Sauvegarder" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`renards-et-lapins-tick-${saved}.gcsim`);
  const path = await file.path();

  // La partie continue…
  await page.getByRole("button", { name: "×4" }).click();
  await expect.poll(() => tickOf(page)).toBeGreaterThan(saved + 10);
  await pause(page);

  // …puis on recharge la sauvegarde : retour au tick sauvegardé.
  await page.getByLabel("Charger une sauvegarde").setInputFiles(path);
  await expect(page.getByRole("status")).toHaveText(`Sauvegarde chargée (tick ${saved}).`);
  await expect(page.getByTestId("tick")).toHaveText(String(saved));
});

test("un fichier qui n'est pas une sauvegarde est refusé", async ({ page }) => {
  await open(page);
  const before = await pause(page);
  await page.getByLabel("Charger une sauvegarde").setInputFiles({
    name: "faux.gcsim",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("ceci n'est pas une sauvegarde"),
  });
  await expect(page.getByRole("status")).toHaveText(
    "Refusé : Ce fichier n'est pas une sauvegarde de simulation.",
  );
  expect(await tickOf(page)).toBe(before);
});

test("le rejeu depuis la graine et le journal donne le même hash", async ({ page }) => {
  await open(page);
  const grid = page.getByLabel("Grille de la simulation");
  await grid.click({ position: { x: 60, y: 60 } });
  await page.getByLabel("40 renards").check();
  await grid.click({ position: { x: 200, y: 120 } });
  await expect.poll(() => tickOf(page)).toBeGreaterThan(30);

  await page.getByRole("button", { name: "Rejouer" }).click();
  await expect(page.getByRole("status")).toContainText("(2 commandes)");
  const game = page.getByTestId("hash-game");
  await expect(game).toHaveText(/^[0-9a-f]{16}$/);
  await expect(page.getByTestId("hash-replay")).toHaveText((await game.textContent())!);
  await expect(page.getByText("Identiques : la simulation est déterministe.")).toBeVisible();
});

test("le mode démo sans Worker utilise le même protocole", async ({ page }) => {
  await open(page, "local=1&seed=e2e");
  await expect(page.getByRole("status")).toContainText("dans la page");
  await expect.poll(() => tickOf(page)).toBeGreaterThan(5);
});
