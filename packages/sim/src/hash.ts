/**
 * Hash d'état pour les tests de déterminisme : FNV-1a 64 bits, calculé sur deux mots de
 * 32 bits (JavaScript n'a pas d'entier 64 bits rapide). Résultat : 16 caractères hexadécimaux.
 *
 * Parcours :
 *   - nombres (8 octets IEEE 754, NaN normalisé), chaînes, booléens, null, undefined, bigint ;
 *   - tableaux et `TypedArray` (octets bruts, type compris : un Uint8Array ≠ un Int8Array) ;
 *   - `Map` et `Set` dans leur ORDRE D'INSERTION (il fait partie de l'état observable) ;
 *   - objets : propriétés propres énumérables, CLÉS TRIÉES (on hache le contenu, pas l'ordre
 *     de construction de l'objet).
 * Lève une erreur sur une fonction, un symbole, une référence cyclique et les objets dont le
 * contenu n'est pas énumérable (Date, RegExp, WeakMap, Promise…), pour ne jamais produire
 * silencieusement le même hash pour deux états différents.
 *
 * ⚠️ Ce n'est pas un hash cryptographique : il sert à comparer deux exécutions, pas à
 * authentifier une donnée.
 */

/** Base et nombre premier FNV-1a 64 bits (découpés en mots de 32 bits). */
const OFFSET_HI = 0xcbf29ce4;
const OFFSET_LO = 0x84222325;
const PRIME_LO = 0x1b3; // nombre premier = 2^40 + 0x1b3
const TWO_32 = 0x1_0000_0000;

/** Tampons partagés pour lire les octets d'un nombre sans allouer. */
const f64 = new Float64Array(1);
const f64Bytes = new Uint8Array(f64.buffer);

/** Étiquette de type écrite avant chaque valeur : `[1]` et `"1"` n'ont pas le même hash. */
const Tag = {
  Undefined: 1,
  Null: 2,
  False: 3,
  True: 4,
  Number: 5,
  String: 6,
  BigInt: 7,
  Array: 8,
  Object: 9,
  Map: 10,
  Set: 11,
  Bytes: 12,
} as const;

/** Étiquette de chaque type de vue binaire (ArrayBuffer et DataView compris). */
const TYPED_TAGS: Record<string, number> = {
  Int8Array: 1,
  Uint8Array: 2,
  Uint8ClampedArray: 3,
  Int16Array: 4,
  Uint16Array: 5,
  Int32Array: 6,
  Uint32Array: 7,
  Float32Array: 8,
  Float64Array: 9,
  BigInt64Array: 10,
  BigUint64Array: 11,
  Float16Array: 12,
  DataView: 13,
  ArrayBuffer: 14,
  SharedArrayBuffer: 15,
};

const UNSUPPORTED = new Set(["Date", "RegExp", "WeakMap", "WeakSet", "WeakRef", "Promise", "Error"]);

class Fnv64 {
  hi = OFFSET_HI;
  lo = OFFSET_LO;

  byte(b: number): void {
    const lo = (this.lo ^ (b & 0xff)) >>> 0;
    // (hi·2^32 + lo) × (2^40 + 0x1b3) mod 2^64, en mots de 32 bits.
    const low = lo * PRIME_LO;
    const carry = Math.floor(low / TWO_32);
    this.lo = low >>> 0;
    this.hi = (Math.imul(this.hi, PRIME_LO) + ((lo << 8) >>> 0) + carry) >>> 0;
  }

  u32(n: number): void {
    this.byte(n);
    this.byte(n >>> 8);
    this.byte(n >>> 16);
    this.byte(n >>> 24);
  }

  number(n: number): void {
    f64[0] = Number.isNaN(n) ? Number.NaN : n;
    for (let i = 0; i < 8; i++) this.byte(f64Bytes[i]!);
  }

  string(s: string): void {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.byte(c);
      this.byte(c >>> 8);
    }
  }

  bytes(view: Uint8Array): void {
    this.u32(view.length);
    for (let i = 0; i < view.length; i++) this.byte(view[i]!);
  }

  digest(): string {
    return this.hi.toString(16).padStart(8, "0") + this.lo.toString(16).padStart(8, "0");
  }
}

/** Hash FNV-1a 64 bits d'une chaîne d'octets (vecteurs officiels testés). */
export function fnv1a64(bytes: Uint8Array): string {
  const h = new Fnv64();
  for (let i = 0; i < bytes.length; i++) h.byte(bytes[i]!);
  return h.digest();
}

/** Hash 64 bits d'une valeur (état de simulation, journal…). */
export function hashState(value: unknown): string {
  const h = new Fnv64();
  visit(h, value, new Set());
  return h.digest();
}

function visit(h: Fnv64, value: unknown, path: Set<object>): void {
  switch (typeof value) {
    case "undefined":
      h.byte(Tag.Undefined);
      return;
    case "boolean":
      h.byte(value ? Tag.True : Tag.False);
      return;
    case "number":
      h.byte(Tag.Number);
      h.number(value);
      return;
    case "string":
      h.byte(Tag.String);
      h.string(value);
      return;
    case "bigint":
      h.byte(Tag.BigInt);
      h.string(value.toString(16));
      return;
    case "function":
      throw new TypeError("hashState : une fonction ne fait pas partie d'un état.");
    case "symbol":
      throw new TypeError("hashState : un symbole ne fait pas partie d'un état.");
  }
  if (value === null) {
    h.byte(Tag.Null);
    return;
  }
  const obj = value as object;
  if (path.has(obj)) throw new TypeError("hashState : référence cyclique.");

  const typed = TYPED_TAGS[Object.prototype.toString.call(obj).slice(8, -1)];
  if (typed !== undefined) {
    h.byte(Tag.Bytes);
    h.byte(typed);
    const view = ArrayBuffer.isView(obj)
      ? new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength)
      : new Uint8Array(obj as ArrayBuffer);
    h.bytes(view);
    return;
  }

  path.add(obj);
  if (Array.isArray(obj)) {
    h.byte(Tag.Array);
    h.u32(obj.length);
    for (let i = 0; i < obj.length; i++) visit(h, obj[i], path);
  } else if (obj instanceof Map) {
    h.byte(Tag.Map);
    h.u32(obj.size);
    for (const [k, v] of obj) {
      visit(h, k, path);
      visit(h, v, path);
    }
  } else if (obj instanceof Set) {
    h.byte(Tag.Set);
    h.u32(obj.size);
    for (const v of obj) visit(h, v, path);
  } else {
    const kind = Object.prototype.toString.call(obj).slice(8, -1);
    if (UNSUPPORTED.has(kind) || obj instanceof Date || obj instanceof RegExp) {
      throw new TypeError(`hashState : un objet ${kind} n'a pas de contenu énumérable à hacher.`);
    }
    const keys = Object.keys(obj).sort();
    h.byte(Tag.Object);
    h.u32(keys.length);
    for (const key of keys) {
      h.string(key);
      visit(h, (obj as Record<string, unknown>)[key], path);
    }
  }
  path.delete(obj);
}
