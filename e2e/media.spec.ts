/**
 * Webcams, de bout en bout (fausse caméra de Chromium, voir playwright.config.ts).
 *   - mode démo : webcam locale, sans serveur ;
 *   - LiveKit : vrai serveur LiveKit (lancé par la CI) ; test sauté si LIVEKIT_URL est absent.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { joinPhone, openScreen } from "./helpers.js";

/** La vidéo affiche-t-elle vraiment des images ? */
async function expectPlaying(video: Locator) {
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth > 0), {
      timeout: 20_000,
    })
    .toBe(true);
}

function cspErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Permissions policy/i.test(m.text()))
      errors.push(m.text());
  });
  return errors;
}

test("mode démo : la webcam du joueur s'affiche sur l'écran et sur le téléphone", async ({ page }) => {
  const errors = cspErrors(page);
  await page.goto("/demo");
  const screen = page.getByRole("region", { name: "Écran de jeu" });
  const phone = page.getByRole("region", { name: "Ton téléphone" });
  await phone.getByRole("button", { name: "📷 Allumer la caméra" }).click();
  await expectPlaying(screen.getByTestId("face-Toi").locator("video"));
  await expectPlaying(phone.getByTestId("face-Toi").locator("video"));
  await phone.getByRole("button", { name: "📷 Couper la caméra" }).click();
  await expect(screen.getByTestId("face-Toi").locator("video")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("LiveKit : la webcam d'un joueur arrive sur l'écran de l'hôte", async ({ browser }) => {
  test.skip(!process.env.LIVEKIT_URL, "Nécessite un serveur LiveKit (LIVEKIT_URL), lancé par la CI.");
  test.setTimeout(90_000);
  const { screen, code } = await openScreen(browser);
  const errors = cspErrors(screen);
  // Case pilotée par le serveur (aller-retour) : on clique puis on attend l'état confirmé.
  const cameras = screen.getByLabel("Caméras");
  await cameras.click();
  await expect(cameras).toBeChecked();

  const alice = await joinPhone(browser, code, "Alice");
  const aliceErrors = cspErrors(alice);
  // Caméras autorisées par l'host : le téléphone publie sa caméra dès sa connexion à la salle.
  await expect(alice.getByRole("button", { name: "📷 Couper la caméra" })).toBeVisible({ timeout: 20_000 });
  await expectPlaying(alice.getByTestId("face-Alice").locator("video"));
  await expectPlaying(screen.getByTestId("face-Alice").locator("video"));

  // L'host coupe les caméras : la vidéo disparaît.
  await cameras.click();
  await expect(cameras).not.toBeChecked();
  await expect(screen.getByTestId("face-Alice").locator("video")).toHaveCount(0, { timeout: 20_000 });
  expect([...errors, ...aliceErrors]).toEqual([]);
});
