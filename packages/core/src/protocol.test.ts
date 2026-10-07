import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, byteLength, clientMessageSchema } from "./protocol.js";

const ok = (msg: unknown) => clientMessageSchema.safeParse(msg).success;

describe("clientMessageSchema", () => {
  it("accepte les messages bien formés", () => {
    expect(ok({ t: "create", v: PROTOCOL_VERSION, as: "screen" })).toBe(true);
    expect(ok({ t: "join", id: 1, v: PROTOCOL_VERSION, code: "ABCD", profile: { name: "Léa" } })).toBe(true);
    expect(ok({ t: "resume", v: PROTOCOL_VERSION, code: "ABCD", token: "a".repeat(43) })).toBe(true);
    expect(ok({ t: "lobby", op: { op: "kick", memberId: "m1" } })).toBe(true);
    expect(ok({ t: "action", action: { anything: true } })).toBe(true);
    expect(ok({ t: "input", data: { x: 0.5 } })).toBe(true);
    expect(ok({ t: "ping", id: 3 })).toBe(true);
  });

  it("rejette les champs inconnus (objets stricts)", () => {
    expect(ok({ t: "ping", admin: true })).toBe(false);
    expect(ok({ t: "join", v: PROTOCOL_VERSION, code: "ABCD", profile: { name: "x", isHost: true } })).toBe(
      false,
    );
    expect(ok({ t: "lobby", op: { op: "start", force: true } })).toBe(false);
  });

  it("rejette une version de protocole incompatible", () => {
    expect(ok({ t: "create", v: PROTOCOL_VERSION + 1, as: "screen" })).toBe(false);
    expect(ok({ t: "create", as: "screen" })).toBe(false);
  });

  it("rejette les jetons mal formés et les valeurs hors bornes", () => {
    expect(ok({ t: "resume", v: PROTOCOL_VERSION, code: "ABCD", token: "court" })).toBe(false);
    expect(ok({ t: "resume", v: PROTOCOL_VERSION, code: "ABCD", token: "a".repeat(40) + "$%^" })).toBe(false);
    expect(ok({ t: "ping", id: -1 })).toBe(false);
    expect(ok({ t: "ping", id: 1.5 })).toBe(false);
    expect(ok({ t: "join", v: PROTOCOL_VERSION, code: "A".repeat(40), profile: { name: "x" } })).toBe(false);
    expect(ok({ t: "unknown" })).toBe(false);
  });
});

describe("byteLength", () => {
  it("compte les octets UTF-8, pas les caractères", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("🦊")).toBe(4);
  });
});
