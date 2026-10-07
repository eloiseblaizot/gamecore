/**
 * Parcours joueurs du jeu d'exemple, de bout en bout : un écran d'hôte et des téléphones.
 */

import { expect, test } from "@playwright/test";
import { LETTERS, answer, configure, correctIndex, joinPhone, openScreen } from "./helpers.js";

test("une partie complète : un écran, trois téléphones, du salon au podium", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  await expect(screen.getByRole("img", { name: "QR code pour rejoindre la partie" })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Lancer la partie" })).toBeDisabled();

  const alice = await joinPhone(browser, code, "Alice");
  const bob = await joinPhone(browser, code, "Bob");
  const chloe = await joinPhone(browser, code, "Chloé");
  await expect(screen.locator(".player-chip")).toHaveText([/Alice/, /Bob/, /Chloé/]);
  await expect(screen.locator(".count")).toHaveText("3");

  await configure(screen, 3, 30);
  await screen.getByRole("button", { name: "Lancer la partie" }).click();

  for (let round = 1; round <= 3; round++) {
    await expect(screen.getByText(`Question ${round} / 3`)).toBeVisible();
    const good = await correctIndex(screen);
    const bad = (good + 1) % 4;
    // Le texte de la question s'affiche aussi sur les téléphones.
    await expect(alice.locator(".phone-question")).toContainText(
      (await screen.locator(".question-text").textContent())!,
    );

    await answer(alice, good);
    await expect(alice.getByTestId("answer-sent")).toBeVisible();
    await expect(screen.getByTestId("answered")).toHaveText("1 / 3 a répondu");
    await answer(bob, bad);
    await answer(chloe, good);

    // Tout le monde a répondu : révélation automatique.
    await expect(screen.locator(".answer.is-correct")).toHaveAttribute(
      "aria-label",
      new RegExp(`^Réponse ${LETTERS[good]} :.*\\(bonne réponse\\)$`),
    );
    await expect(alice.getByTestId("result")).toHaveText(/^Bonne réponse ! \+\d+$/);
    await expect(bob.getByTestId("result")).toHaveText("Raté !");
    await expect(bob.getByText(new RegExp(`^C'était ${LETTERS[good]} :`))).toBeVisible();
    await expect(chloe.getByTestId("result")).toHaveText(/^Bonne réponse !/);

    await screen.getByRole("button", { name: round < 3 ? "Question suivante" : "Voir le podium" }).click();
  }

  // Podium : Alice répond toujours la première, elle gagne ; Bob n'a jamais eu bon.
  await expect(screen.getByRole("heading", { name: "Podium" })).toBeVisible();
  await expect(screen.locator(".podium-row").first()).toContainText("Alice");
  await expect(screen.locator(".podium-row").last()).toContainText("Bob");
  await expect(alice.getByTestId("final-rank")).toHaveText("1re place ! sur 3");
  await expect(bob.getByTestId("final-rank")).toHaveText("3e place sur 3");
  await expect(bob.getByTestId("my-score")).toHaveText("0 pts");

  // Revanche directe depuis l'écran.
  await screen.getByRole("button", { name: "Rejouer" }).click();
  await expect(screen.getByText("Question 1 / 3")).toBeVisible();
  await expect(alice.getByTestId("my-score")).toHaveText("0 pts");
});

test("le chrono ferme les réponses même si un joueur ne répond pas", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  const alice = await joinPhone(browser, code, "Alice");
  await joinPhone(browser, code, "Bob");
  await configure(screen, 3, 10);
  await screen.getByRole("button", { name: "Lancer la partie" }).click();
  await answer(alice, await correctIndex(screen));
  await expect(screen.getByRole("timer")).toBeVisible();
  await expect(screen.locator(".answer.is-correct")).toBeVisible({ timeout: 15_000 });
  await expect(screen.locator(".scoreboard li")).toHaveCount(2);
});

test("un téléphone qui recharge la page garde sa place et ses points", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  const alice = await joinPhone(browser, code, "Alice");
  const bob = await joinPhone(browser, code, "Bob");
  await configure(screen, 3, 30);
  await screen.getByRole("button", { name: "Lancer la partie" }).click();

  await answer(alice, await correctIndex(screen));
  await answer(bob, await correctIndex(screen));
  await expect(alice.getByTestId("result")).toBeVisible();
  const score = await alice.getByTestId("my-score").textContent();

  await alice.reload();
  await expect(alice.getByTestId("result")).toBeVisible();
  await expect(alice.getByTestId("my-score")).toHaveText(score!);
  await expect(alice.locator(".phone-header")).toContainText("Alice");
  // Pas de doublon côté écran : toujours deux joueurs.
  await expect(screen.locator(".scoreboard li")).toHaveCount(2);

  await screen.getByRole("button", { name: "Question suivante" }).click();
  await answer(alice, 0);
  await expect(alice.getByTestId("answer-sent")).toBeVisible();
});

test("l'écran rechargé retrouve ses droits d'host", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  await joinPhone(browser, code, "Alice");
  await screen.reload();
  await expect(screen.getByRole("button", { name: "Lancer la partie" })).toBeEnabled();
  await expect(screen.getByRole("button", { name: "Retirer Alice" })).toBeVisible();
});

test("l'host peut retirer un joueur, qui en est informé", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  await joinPhone(browser, code, "Alice");
  const troll = await joinPhone(browser, code, "Troll");
  await screen.getByRole("button", { name: "Retirer Troll" }).click();
  await expect(troll.getByRole("heading", { name: "Tu as été retiré de la partie" })).toBeVisible();
  await expect(screen.locator(".player-chip")).toHaveText([/Alice/]);
  // Son jeton ne fonctionne plus : en rechargeant, il doit repasser par le formulaire.
  await troll.reload();
  await expect(troll.getByLabel("Ton pseudo")).toBeVisible();
});

test("le premier joueur peut lancer la partie depuis son téléphone", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  const alice = await joinPhone(browser, code, "Alice");
  const bob = await joinPhone(browser, code, "Bob");
  await expect(bob.getByRole("button", { name: "Lancer la partie" })).toHaveCount(0);
  await alice.getByRole("button", { name: "Lancer la partie" }).click();
  await expect(screen.getByText(/^Question 1 \//)).toBeVisible();
});

test("un code inconnu ou mal formé est signalé", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Code de la partie").fill("0O1I");
  await page.getByRole("button", { name: "Rejoindre" }).click();
  await expect(page.getByRole("alert")).toHaveText("Ce code ne ressemble pas à un code de partie.");

  await page.getByLabel("Code de la partie").fill("zzzzzz");
  await page.getByRole("button", { name: "Rejoindre" }).click();
  await expect(page).toHaveURL(/\/play\/ZZZZZZ$/);
  await page.getByLabel("Ton pseudo").fill("Perdu");
  await page.getByRole("button", { name: "C'est parti !" }).click();
  await expect(page.getByRole("heading", { name: "Partie introuvable" })).toBeVisible();
  await page.getByRole("button", { name: "Retour à l'accueil" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("les réactions des téléphones s'affichent sur l'écran", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  const alice = await joinPhone(browser, code, "Alice");
  await alice.getByRole("button", { name: "Réagir 🔥" }).click();
  await expect(screen.locator(".reaction")).toContainText("🔥");
  await expect(screen.locator(".reaction small")).toHaveText("Alice");
});

test("le téléphone se joue aussi au clavier", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  const alice = await joinPhone(browser, code, "Alice");
  await configure(screen, 3, 30);
  await screen.getByRole("button", { name: "Lancer la partie" }).click();
  const good = await correctIndex(screen);
  await alice.getByRole("button", { name: new RegExp(`^Réponse ${LETTERS[good]} :`) }).focus();
  await alice.keyboard.press("Enter");
  await expect(alice.getByTestId("result")).toHaveText(/^Bonne réponse !/);
});
