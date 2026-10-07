import { describe, expect, it } from "vitest";
import { graphemeLength, sanitizeAvatar, sanitizeDisplayName, sanitizeLine, uniqueName } from "./sanitize.js";

describe("sanitizeDisplayName", () => {
  it("retire les espaces superflus et les caractères invisibles", () => {
    expect(sanitizeDisplayName("  Léa​  la\n\tbest ")).toBe("Léa la best");
    expect(sanitizeDisplayName("\u0000\u0007")).toBeNull();
    expect(sanitizeDisplayName("   ")).toBeNull();
    expect(sanitizeDisplayName(42)).toBeNull();
  });

  it("neutralise les inversions de sens d'écriture (Trojan Source)", () => {
    const name = sanitizeDisplayName("admin‮gnp.exe");
    expect(name).not.toMatch(/[‪-‮⁦-⁩]/);
  });

  it("normalise les caractères compatibles (NFKC)", () => {
    expect(sanitizeDisplayName("Ｌéa")).toBe("Léa");
  });

  it("tronque au nombre de caractères perçus, sans couper un emoji", () => {
    const family = "👨‍👩‍👧‍👦";
    const name = sanitizeDisplayName(family.repeat(30));
    expect(name).not.toBeNull();
    expect(graphemeLength(name!)).toBe(24);
    expect(name).toBe(family.repeat(24));
    expect(sanitizeLine("abcdef", 3)).toBe("abc");
  });
});

describe("uniqueName", () => {
  it("ajoute un numéro si le pseudo est déjà pris (sans tenir compte des accents ni de la casse)", () => {
    expect(uniqueName("Léa", [])).toBe("Léa");
    expect(uniqueName("Léa", ["lea"])).toBe("Léa 2");
    expect(uniqueName("Léa", ["Léa", "Léa 2"])).toBe("Léa 3");
  });

  it("respecte la longueur maximale", () => {
    const long = "x".repeat(24);
    expect(uniqueName(long, [long])).toHaveLength(24);
  });
});

describe("sanitizeAvatar", () => {
  it("accepte les emojis et les images Discord", () => {
    expect(sanitizeAvatar("🦊")).toBe("🦊");
    expect(sanitizeAvatar("https://cdn.discordapp.com/avatars/1/abc.png")).toBe(
      "https://cdn.discordapp.com/avatars/1/abc.png",
    );
  });

  it("refuse les schémas dangereux, les hôtes inconnus et le texte", () => {
    for (const bad of [
      // eslint-disable-next-line no-script-url -- c'est précisément ce qu'on veut refuser
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "http://cdn.discordapp.com/a.png",
      "https://evil.example/pixel.png",
      "https://user:pass@cdn.discordapp.com/a.png",
      "Bob",
      "",
      null,
      "x".repeat(600),
    ]) {
      expect(sanitizeAvatar(bad)).toBeNull();
    }
  });
});
