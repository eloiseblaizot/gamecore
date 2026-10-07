import { isRoomCode } from "@gamecore/core";
import { describe, expect, it } from "vitest";
import { activityRoomCode, discordAvatarUrl, discordDisplayName } from "./shared.js";

describe("utilisateur Discord", () => {
  it("préfère le nom global au nom d'utilisateur", () => {
    expect(discordDisplayName({ id: "1", username: "lea_42", global_name: "Léa" })).toBe("Léa");
    expect(discordDisplayName({ id: "1", username: "lea_42", global_name: "  " })).toBe("lea_42");
    expect(discordDisplayName({ id: "1", username: "lea_42" })).toBe("lea_42");
  });

  it("construit l'URL de l'avatar, ou un avatar par défaut", () => {
    const id = "80351110224678912";
    expect(discordAvatarUrl({ id, username: "x", avatar: "8342729096ea3675442027381ff50dfe" })).toBe(
      `https://cdn.discordapp.com/avatars/${id}/8342729096ea3675442027381ff50dfe.png?size=128`,
    );
    expect(discordAvatarUrl({ id, username: "x", avatar: null })).toMatch(
      /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/,
    );
    // Un « hash » d'avatar inattendu n'est jamais injecté dans l'URL.
    expect(discordAvatarUrl({ id, username: "x", avatar: "../../evil" })).toContain("/embed/avatars/");
  });
});

describe("activityRoomCode", () => {
  it("donne le même code valide à toutes les personnes d'une même instance", async () => {
    const a = await activityRoomCode("i-1234567890-gc-912952092627435520-912952092627435521");
    expect(a).toHaveLength(12);
    expect(isRoomCode(a)).toBe(true);
    expect(await activityRoomCode("i-1234567890-gc-912952092627435520-912952092627435521")).toBe(a);
    expect(await activityRoomCode("i-autre-instance")).not.toBe(a);
  });

  it("refuse un identifiant d'instance absurde", async () => {
    await expect(activityRoomCode("")).rejects.toThrow(RangeError);
    await expect(activityRoomCode("x".repeat(300))).rejects.toThrow(RangeError);
  });
});
