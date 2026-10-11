/**
 * Son synthétisé, de bout en bout : règles d'autoplay, coupure, réglages mémorisés.
 * (On ne peut pas « écouter » en test, mais on vérifie quand et comment le son s'active.)
 */

import { expect, test, type Page } from "@playwright/test";

/** Compte les contextes audio créés par la page et expose le dernier. */
async function spyAudio(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __audioContexts: AudioContext[]; AudioContext: typeof AudioContext };
    w.__audioContexts = [];
    const Native = w.AudioContext;
    w.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        w.__audioContexts.push(this);
      }
    };
  });
}

const contexts = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __audioContexts: AudioContext[] }).__audioContexts.map((c) => c.state),
  );

test("aucun son avant un geste de l'utilisateur, puis le son s'active au premier clic", async ({ page }) => {
  await spyAudio(page);
  await page.goto("/demo");
  await expect(page.getByRole("region", { name: "Écran de jeu" })).toBeVisible();
  expect(await contexts(page)).toEqual([]);

  await page
    .getByRole("region", { name: "Ton téléphone" })
    .getByRole("button", { name: "Lancer la partie" })
    .click();
  await expect.poll(() => contexts(page)).toEqual(["running"]);
  // Toujours un seul contexte, quels que soient les sons joués ensuite.
  await expect(page.getByText(/^Question 1 \//)).toBeVisible();
  expect(await contexts(page)).toHaveLength(1);
});

test("la touche M coupe le son, et le réglage est mémorisé", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Réglages du son" })).toBeVisible();
  await page.keyboard.press("m");
  await expect(page.getByRole("button", { name: "Son coupé : ouvrir les réglages du son" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Son coupé : ouvrir les réglages du son" })).toBeVisible();
  await page.keyboard.press("m");
  await expect(page.getByRole("button", { name: "Réglages du son" })).toBeVisible();
});

test("la touche M ne coupe pas le son pendant une saisie", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Code de la partie").fill("m");
  await page.getByLabel("Code de la partie").press("m");
  await expect(page.getByRole("button", { name: "Réglages du son" })).toBeVisible();
});

test("les volumes se règlent depuis le panneau du son", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Réglages du son" }).click();
  const panel = page.getByRole("group", { name: "Réglages du son" });
  await panel.getByLabel("🎵 Musique").fill("0");
  await panel.getByLabel("✨ Effets").fill("0");
  // Musique et effets à zéro : le bouton indique que le son est coupé.
  await expect(page.getByRole("button", { name: "Son coupé : ouvrir les réglages du son" })).toBeVisible();
  const saved = await page.evaluate(() => localStorage.getItem("buzzer-audio"));
  expect(JSON.parse(saved!)).toMatchObject({ music: 0, sfx: 0, muted: false });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});
