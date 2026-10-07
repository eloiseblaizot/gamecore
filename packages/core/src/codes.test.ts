import { describe, expect, it } from "vitest";
import {
  ROOM_CODE_ALPHABET,
  generateRoomCode,
  generateToken,
  hashToken,
  isRoomCode,
  normalizeRoomCode,
  timingSafeEqual,
} from "./codes.js";

describe("codes de salon", () => {
  it("n'utilise que des symboles non ambigus", () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[0O1I]/);
  });

  it("génère des codes valides, de la longueur demandée, et différents", () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateRoomCode()));
    expect(codes.size).toBe(500);
    for (const code of codes) {
      expect(code).toHaveLength(6);
      expect(isRoomCode(code)).toBe(true);
    }
    expect(generateRoomCode(8)).toHaveLength(8);
    expect(() => generateRoomCode(3)).toThrow(RangeError);
  });

  it("normalise la saisie d'un joueur", () => {
    expect(normalizeRoomCode(" k7q-xpb ")).toBe("K7QXPB");
    expect(normalizeRoomCode("ab<script>")).toBe("ABSCRIPT");
    expect(isRoomCode("K7QXPB")).toBe(true);
    expect(isRoomCode("K0QXPB")).toBe(false);
    expect(isRoomCode("ABC")).toBe(false);
  });
});

describe("jetons", () => {
  it("sont aléatoires et en base64url", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
  });

  it("sont stockés sous forme d'empreinte stable", async () => {
    const token = generateToken();
    const h1 = await hashToken(token);
    expect(h1).toBe(await hashToken(token));
    expect(h1).not.toContain(token);
    expect(await hashToken(token + "x")).not.toBe(h1);
  });

  it("se comparent à durée constante", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
