/**
 * Connexion Discord de bout en bout, face à un faux Discord local (e2e/fake-discord.ts) qui
 * applique les mêmes vérifications que le vrai (PKCE, code à usage unique, URL de retour).
 */

import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import { openScreen } from "./helpers.js";

/** Un téléphone dont le « compte Discord » est `user` (voir les utilisateurs du faux Discord). */
async function discordPhone(browser: Browser, user: "lea" | "troll"): Promise<Page> {
  const context = await browser.newContext({ ...devices["Pixel 7"], locale: "fr-FR" });
  await context.addCookies([{ name: "fake_discord_user", value: user, domain: "localhost", path: "/" }]);
  // Aucun accès à Internet : les avatars du CDN de Discord sont servis localement.
  await context.route("https://cdn.discordapp.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: "<svg xmlns='http://www.w3.org/2000/svg'/>",
    }),
  );
  return context.newPage();
}

async function loginWithDiscord(phone: Page, code: string): Promise<void> {
  await phone.goto(`/play/${code}`);
  await phone.getByRole("button", { name: "Se connecter avec Discord" }).click();
}

test("un joueur se connecte avec Discord depuis son téléphone", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  const phone = await discordPhone(browser, "lea");
  const tokenResponses: string[] = [];
  phone.on("response", (res) => {
    if (res.url().endsWith("/api/discord/token")) void res.text().then((t) => tokenResponses.push(t));
  });

  await loginWithDiscord(phone, code);
  await expect(phone.getByRole("heading", { name: "C'est bon, Léa Discord !" })).toBeVisible();
  // Retour au jeu, sans le code d'autorisation dans l'URL ni dans l'historique.
  await expect(phone).toHaveURL(new RegExp(`/play/${code}$`));

  const chip = screen.locator(".player-chip", { hasText: "Léa Discord" });
  await expect(chip).toBeVisible();
  await expect(chip.locator("img")).toHaveAttribute("src", /^https:\/\/cdn\.discordapp\.com\//);

  // Le jeton de rafraîchissement renvoyé par Discord ne quitte jamais le serveur.
  expect(tokenResponses).toHaveLength(1);
  expect(tokenResponses[0]).toContain("accessToken");
  expect(tokenResponses[0]).not.toContain("ne-doit-jamais-sortir-du-serveur");
});

test("un compte Discord expulsé ne peut pas revenir, même avec une nouvelle connexion", async ({
  browser,
}) => {
  const { screen, code } = await openScreen(browser);
  const troll = await discordPhone(browser, "troll");
  await loginWithDiscord(troll, code);
  await expect(troll.getByRole("heading", { name: "C'est bon, Troll Discord !" })).toBeVisible();

  await screen.getByRole("button", { name: "Retirer Troll Discord" }).click();
  await expect(troll.getByRole("heading", { name: "Tu as été retiré de la partie" })).toBeVisible();

  await loginWithDiscord(troll, code);
  await expect(troll.getByRole("heading", { name: "Accès refusé" })).toBeVisible();
  await expect(troll.getByText("Tu as été expulsé de ce salon.")).toBeVisible();
  await expect(screen.locator(".player-chip")).toHaveCount(0);
});

test("une réponse Discord falsifiée (state inconnu) est refusée", async ({ page }) => {
  await page.goto("/auth/discord?code=code-vole&state=etat-forge");
  await expect(page.getByRole("heading", { name: "Connexion Discord impossible" })).toBeVisible();
  await expect(page.getByText("Connexion Discord invalide : recommence depuis le jeu.")).toBeVisible();
});

test("la configuration publique ne contient aucun secret", async ({ request }) => {
  const res = await request.get("/api/config");
  const text = await res.text();
  expect(JSON.parse(text)).toMatchObject({ discord: { clientId: "fake-client" } });
  expect(text).not.toContain("fake-secret");
  expect(res.headers()["cache-control"]).toBe("no-store");
});

test("la route d'échange refuse les requêtes mal formées", async ({ request }) => {
  const url = "/api/discord/token";
  expect((await request.get(url)).status()).toBe(405);
  expect((await request.post(url, { data: { code: "a b" } })).status()).toBe(400);
  expect((await request.post(url, { data: { code: "inconnu" } })).status()).toBe(401);
});
