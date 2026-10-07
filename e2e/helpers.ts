/**
 * Outils communs aux tests de bout en bout du jeu d'exemple.
 */

import { devices, expect, type Browser, type Page } from "@playwright/test";
import { QUESTIONS } from "../examples/buzzer/src/questions.js";

export const LETTERS = ["A", "B", "C", "D"] as const;

/** Ouvre l'écran de l'hôte sur un « PC » et crée une partie. Renvoie le code du salon. */
export async function openScreen(browser: Browser): Promise<{ screen: Page; code: string }> {
  const context = await browser.newContext({
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
  });
  const screen = await context.newPage();
  await screen.goto("/");
  await screen.getByRole("button", { name: "Créer une partie" }).click();
  await expect(screen).toHaveURL(/\/screen\/[A-Z2-9]{6}$/);
  const code = (await screen.getByTestId("room-code").textContent())!.trim();
  return { screen, code };
}

/** Un joueur arrive sur un « téléphone » (émulation mobile tactile) par l'URL du QR code. */
export async function joinPhone(browser: Browser, code: string, name: string): Promise<Page> {
  const context = await browser.newContext({ ...devices["Pixel 7"], locale: "fr-FR" });
  const phone = await context.newPage();
  await phone.goto(`/play/${code}`);
  await phone.getByLabel("Ton pseudo").fill(name);
  await phone.getByRole("button", { name: "C'est parti !" }).click();
  await expect(phone.getByRole("heading", { name: `C'est bon, ${name} !` })).toBeVisible();
  return phone;
}

/** Règle le nombre de questions et le temps de réponse depuis l'écran (host). */
export async function configure(screen: Page, questions: number, seconds: number): Promise<void> {
  await screen.getByLabel("Questions").selectOption(String(questions));
  await screen.getByLabel("Temps pour répondre").selectOption(String(seconds));
}

/** La bonne réponse de la question affichée (le test a le droit de tricher, pas les joueurs). */
export async function correctIndex(screen: Page): Promise<number> {
  const text = (await screen.locator(".question-text").textContent())!.trim();
  const question = QUESTIONS.find((q) => q.text === text);
  if (!question) throw new Error(`Question inconnue : ${text}`);
  return question.answer;
}

/** Appuie sur le buzzer de la réponse `index` sur un téléphone. */
export async function answer(phone: Page, index: number): Promise<void> {
  await phone.getByRole("button", { name: new RegExp(`^Réponse ${LETTERS[index]} :`) }).click();
}
