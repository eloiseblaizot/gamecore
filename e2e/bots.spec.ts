/**
 * Bots et mode démo, de bout en bout.
 */

import { expect, test } from "@playwright/test";
import { DEMO_QUESTIONS } from "../examples/buzzer/src/demo-questions.js";
import { LETTERS, answer, configure, joinPhone, openScreen } from "./helpers.js";

test("mode démo : une partie complète contre des bots, sans aucune connexion au serveur de jeu", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));

  await page.goto("/");
  await page.getByRole("button", { name: "🤖 Essayer en solo contre des bots" }).click();
  await expect(page).toHaveURL(/\/demo$/);
  const screen = page.getByRole("region", { name: "Écran de jeu" });
  const phone = page.getByRole("region", { name: "Ton téléphone" });

  await expect(screen.locator(".badge-bot")).toHaveCount(3);
  await expect(screen.getByRole("img", { name: /QR code/ })).toHaveCount(0); // personne ne peut rejoindre
  await screen.getByLabel("Questions").selectOption("3");
  await screen.getByLabel("Temps pour répondre").selectOption("10");
  await phone.getByRole("button", { name: "Lancer la partie" }).click();

  for (let round = 1; round <= 3; round++) {
    await expect(screen.getByText(`Question ${round} / 3`)).toBeVisible();
    const text = (await screen.locator(".question-text").textContent())!.trim();
    const question = DEMO_QUESTIONS.find((q) => q.text === text)!;
    await phone.getByRole("button", { name: new RegExp(`^Réponse ${LETTERS[question.answer]} :`) }).click();
    // Les bots répondent seuls (au plus 70 % du chrono) : la révélation arrive sans attendre la fin.
    await expect(phone.getByTestId("result")).toHaveText(/^Bonne réponse ! \+\d+$/, { timeout: 15_000 });
    await expect(screen.locator(".scoreboard li")).toHaveCount(4);
    await screen.getByRole("button", { name: round < 3 ? "Question suivante" : "Voir le podium" }).click();
  }

  await expect(screen.getByRole("heading", { name: "Podium" })).toBeVisible();
  await expect(phone.getByTestId("final-rank")).toBeVisible();
  // Tout s'est joué dans la page : aucune WebSocket n'a été ouverte.
  expect(sockets).toEqual([]);
});

test("l'host complète une vraie partie avec un bot", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  const alice = await joinPhone(browser, code, "Alice");
  await screen.getByRole("button", { name: "🤖 Ajouter un bot" }).click();
  const bot = screen.locator(".player-chip", { has: screen.locator(".badge-bot") });
  await expect(bot).toHaveCount(1);
  await expect(alice.getByText("2 joueurs dans la partie")).toBeVisible();

  await configure(screen, 3, 10);
  await screen.getByRole("button", { name: "Lancer la partie" }).click();
  await answer(alice, 0);
  await expect(screen.getByTestId("answered")).toHaveText(/^2 \/ 2/, { timeout: 15_000 });
  await expect(screen.locator(".scoreboard li")).toHaveCount(2);
});

test("l'host peut retirer un bot", async ({ browser }) => {
  const { screen } = await openScreen(browser);
  await screen.getByRole("button", { name: "🤖 Ajouter un bot" }).click();
  const chip = screen.locator(".player-chip", { has: screen.locator(".badge-bot") });
  const name = (await chip.locator(".player-name").textContent())!;
  await screen.getByRole("button", { name: `Retirer ${name}` }).click();
  await expect(chip).toHaveCount(0);
});
