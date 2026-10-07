/**
 * Sécurité, vérifiée de bout en bout sur le serveur de production du jeu d'exemple.
 */

import { expect, test, type Page, type WebSocket } from "@playwright/test";
import { QUESTIONS } from "../examples/buzzer/src/questions.js";
import { answer, configure, correctIndex, joinPhone, openScreen } from "./helpers.js";

/**
 * Enregistre les messages gamecore que la page reçoit par WebSocket. Les trames Socket.io
 * (`42["gc","{…}"]`) sont décodées pour ne garder que le JSON du protocole gamecore.
 */
function recordFrames(page: Page): string[] {
  const messages: string[] = [];
  page.on("websocket", (ws: WebSocket) => {
    ws.on("framereceived", ({ payload }) => {
      const frame = typeof payload === "string" ? payload : payload.toString();
      if (!frame.startsWith("42")) return;
      const [event, data] = JSON.parse(frame.slice(2)) as [string, unknown];
      if (event === "gc" && typeof data === "string") messages.push(data);
    });
  });
  return messages;
}

test("aucun téléphone ne reçoit la bonne réponse ni la réponse d'un autre avant la révélation", async ({
  browser,
}) => {
  const { screen, code } = await openScreen(browser);
  const alice = await joinPhone(browser, code, "Alice");
  // Bob enregistre tout ce qui arrive sur son téléphone, dès avant son entrée dans le salon.
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  const bobFrames = recordFrames(bob);
  await bob.goto(`/play/${code}`);
  await bob.getByLabel("Ton pseudo").fill("Bob");
  await bob.getByRole("button", { name: "C'est parti !" }).click();
  await joinPhone(browser, code, "Chloé");

  await configure(screen, 3, 30);
  await screen.getByRole("button", { name: "Lancer la partie" }).click();
  const good = await correctIndex(screen);
  // Alice répond une réponse précise, que Bob ne doit jamais apprendre avant la révélation.
  await answer(alice, (good + 2) % 4);
  await expect(screen.getByTestId("answered")).toHaveText("1 / 3 a répondu");
  await answer(bob, good);
  await expect(screen.getByTestId("answered")).toHaveText("2 / 3 ont répondu");

  const beforeReveal = bobFrames.join("\n");
  expect(beforeReveal).toContain('"phase":"question"');
  // Ni la bonne réponse, ni l'état interne des réponses, ni la vue privée d'Alice.
  expect(beforeReveal).not.toContain('"correct"');
  expect(beforeReveal).not.toContain('"answers"');
  expect(beforeReveal).not.toMatch(/"myAnswer":(?!null|\d)/);
  const aliceChoices = beforeReveal.match(/"myAnswer":\d/g) ?? [];
  expect(new Set(aliceChoices)).toEqual(new Set([`"myAnswer":${good}`]));
});

test("le JavaScript envoyé aux joueurs ne contient pas les réponses", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!);
  expect(scripts.length).toBeGreaterThan(0);
  for (const src of scripts) {
    const js = await (await request.get(src)).text();
    for (const q of QUESTIONS) {
      expect(js).not.toContain(q.text);
      // Les réponses courtes (« 3 », « 6 »…) apparaissent forcément ailleurs dans le code.
      const good = q.choices[q.answer];
      if (good.length >= 6) expect(js).not.toContain(good);
    }
  }
});

test("les pages sont servies avec des en-têtes de sécurité stricts", async ({ request }) => {
  const res = await request.get("/play/ABCDEF");
  const headers = res.headers();
  expect(headers["content-security-policy"]).toContain("script-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["permissions-policy"]).toContain("camera=()");
});

test("le serveur ne sert aucun fichier hors de l'application", async ({ request }) => {
  for (const path of ["/../package.json", "/%2e%2e/%2e%2e/package.json", "/..%2f..%2fpackage.json"]) {
    const res = await request.get(path);
    expect(await res.text()).not.toContain('"name": "@gamecore');
  }
  expect((await request.post("/")).status()).toBe(405);
});

test("une origine étrangère ne peut pas ouvrir de connexion de jeu", async ({ request, baseURL }) => {
  const url = "/socket.io/?EIO=4&transport=polling";
  expect((await request.get(url, { headers: { Origin: "https://site-malveillant.example" } })).status()).toBe(
    403,
  );
  expect((await request.get(url, { headers: { Origin: baseURL! } })).status()).toBe(200);
});

test("le pseudo est nettoyé et ne peut pas injecter de HTML", async ({ browser }) => {
  const { screen, code } = await openScreen(browser);
  let dialog = false;
  screen.on("dialog", () => (dialog = true));
  // 23 caractères : sous la limite des pseudos (24), il n'est donc pas tronqué.
  const payload = "<img src=x onerror=f()>";
  await joinPhone(browser, code, payload);
  await expect(screen.locator(".player-chip")).toContainText(payload);
  expect(await screen.locator(".player-chip img").count()).toBe(0);
  expect(dialog).toBe(false);
});
