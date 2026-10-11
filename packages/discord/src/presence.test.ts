import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inviteToActivity } from "./client.js";
import { createPresence, presenceActivity, type PresenceSdk } from "./presence.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

function fakeSdk() {
  const setActivity = vi.fn(async (_args: unknown) => null);
  const sdk: PresenceSdk = { commands: { setActivity } };
  return {
    sdk,
    setActivity,
    sent: () => setActivity.mock.calls.map((c) => (c[0] as { activity: unknown }).activity),
  };
}

describe("presenceActivity", () => {
  it("convertit une présence au format de Discord", () => {
    expect(
      presenceActivity({
        details: "Question 3 / 5",
        state: "1 200 points",
        startedAt: 1000.4,
        endsAt: 5000,
        party: { size: 3, max: 12, id: "salon" },
        largeImage: "buzzer",
        largeText: "Buzzer !",
      }),
    ).toEqual({
      type: 0,
      details: "Question 3 / 5",
      state: "1 200 points",
      timestamps: { start: 1000, end: 5000 },
      party: { id: "salon", size: [3, 12] },
      assets: {
        large_image: "buzzer",
        large_text: "Buzzer !",
        small_image: undefined,
        small_text: undefined,
      },
    });
  });

  it("nettoie et borne les valeurs", () => {
    const newline = String.fromCharCode(10);
    const rtlOverride = String.fromCharCode(0x202e);
    const activity = presenceActivity({
      details: `  Trop${newline}long ${"x".repeat(300)}`,
      state: rtlOverride,
      startedAt: Number.NaN,
      party: { size: 20, max: 4 },
      // eslint-disable-next-line no-script-url -- c'est précisément ce qu'on veut refuser
      largeImage: "javascript:alert(1)",
    });
    expect(activity.details!.length).toBeLessThanOrEqual(128);
    expect(activity.details).toMatch(/^Trop long x+$/);
    expect(activity.state).toBeUndefined();
    expect(activity.timestamps).toBeUndefined();
    expect(activity.party).toEqual({ id: undefined, size: [4, 4] });
    expect(activity.assets).toBeUndefined();
    expect(presenceActivity({})).toEqual({ type: 0 });
  });
});

describe("createPresence", () => {
  it("regroupe les mises à jour et n'envoie que la dernière", async () => {
    const { sdk, sent } = fakeSdk();
    const presence = createPresence(sdk, { minIntervalMs: 4000 });
    presence.set({ details: "Salon" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toEqual([{ type: 0, details: "Salon" }]);
    presence.set({ details: "Question 1" });
    presence.set({ details: "Question 2" });
    await vi.advanceTimersByTimeAsync(3999);
    expect(sent()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent()).toEqual([
      { type: 0, details: "Salon" },
      { type: 0, details: "Question 2" },
    ]);
  });

  it("n'envoie pas deux fois la même présence, et efface avec null", async () => {
    const { sdk, sent } = fakeSdk();
    const presence = createPresence(sdk, { minIntervalMs: 1000 });
    presence.set({ details: "Salon" });
    await vi.advanceTimersByTimeAsync(0);
    presence.set({ details: "Salon" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent()).toHaveLength(1);
    presence.set(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent()).toEqual([{ type: 0, details: "Salon" }, null]);
  });

  it("efface la présence à l'arrêt et ignore la suite", async () => {
    const { sdk, sent } = fakeSdk();
    const presence = createPresence(sdk);
    presence.set({ details: "En partie" });
    await vi.advanceTimersByTimeAsync(0);
    presence.dispose();
    presence.set({ details: "Après" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent()).toEqual([{ type: 0, details: "En partie" }, null]);
  });

  it("survit à un refus de Discord (portée manquante)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const setActivity = vi.fn(async () => Promise.reject(new Error("portée refusée")));
    const presence = createPresence({ commands: { setActivity } }, { minIntervalMs: 0 });
    presence.set({ details: "x" });
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalled();
    // Le prochain essai identique est retenté (la précédente n'a pas été enregistrée).
    presence.set({ details: "x" });
    await vi.advanceTimersByTimeAsync(0);
    expect(setActivity).toHaveBeenCalledTimes(2);
  });
});

describe("inviteToActivity", () => {
  it("ouvre la fenêtre d'invitation, ou renvoie false si Discord la refuse", async () => {
    const ok = { sdk: { commands: { openInviteDialog: vi.fn(async () => null) } } };
    expect(await inviteToActivity(ok as never)).toBe(true);
    const refused = {
      sdk: { commands: { openInviteDialog: vi.fn(async () => Promise.reject(new Error("DM"))) } },
    };
    expect(await inviteToActivity(refused as never)).toBe(false);
  });
});
