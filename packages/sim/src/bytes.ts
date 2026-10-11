/**
 * Écriture et lecture binaires (petit-boutiste), pour écrire facilement le `codec` d'une
 * simulation : nombres, chaînes UTF-8, tableaux d'octets et `TypedArray`.
 *
 *   encode(state) {
 *     const w = new ByteWriter();
 *     w.u16(state.size);
 *     w.typed(state.cells);
 *     return w.finish();
 *   }
 *   decode(bytes) {
 *     const r = new ByteReader(bytes);
 *     return { size: r.u16(), cells: r.uint8Array() };
 *   }
 *
 * Toute lecture au-delà de la fin lève une `RangeError` (sauvegarde tronquée ou falsifiée).
 */

type Typed =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class ByteWriter {
  private buffer: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(initialSize = 1024) {
    this.buffer = new Uint8Array(Math.max(16, initialSize));
    this.view = new DataView(this.buffer.buffer);
  }

  /** Octets écrits jusqu'ici. */
  get length(): number {
    return this.offset;
  }

  private ensure(bytes: number): void {
    if (this.offset + bytes <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.offset + bytes) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.offset));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(n: number): this {
    this.ensure(1);
    this.view.setUint8(this.offset, n);
    this.offset += 1;
    return this;
  }

  u16(n: number): this {
    this.ensure(2);
    this.view.setUint16(this.offset, n, true);
    this.offset += 2;
    return this;
  }

  u32(n: number): this {
    this.ensure(4);
    this.view.setUint32(this.offset, n, true);
    this.offset += 4;
    return this;
  }

  i32(n: number): this {
    this.ensure(4);
    this.view.setInt32(this.offset, n, true);
    this.offset += 4;
    return this;
  }

  f64(n: number): this {
    this.ensure(8);
    this.view.setFloat64(this.offset, n, true);
    this.offset += 8;
    return this;
  }

  bool(b: boolean): this {
    return this.u8(b ? 1 : 0);
  }

  /** Octets bruts, précédés de leur longueur (u32). */
  bytes(bytes: Uint8Array): this {
    this.u32(bytes.length);
    this.ensure(bytes.length);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.length;
    return this;
  }

  /** Chaîne UTF-8, précédée de sa longueur en octets (u32). */
  string(s: string): this {
    return this.bytes(encoder.encode(s));
  }

  /** Contenu d'un `TypedArray` (longueur en éléments, puis octets). Relire avec la méthode du même type. */
  typed(array: Typed): this {
    this.u32(array.length);
    const raw = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    this.ensure(raw.length);
    this.buffer.set(raw, this.offset);
    this.offset += raw.length;
    return this;
  }

  /** Copie exacte des octets écrits. */
  finish(): Uint8Array {
    return this.buffer.slice(0, this.offset);
  }
}

export class ByteReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Octets restant à lire. */
  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private need(n: number): number {
    if (n < 0 || this.offset + n > this.bytes.length) {
      throw new RangeError("Données binaires tronquées ou invalides.");
    }
    const at = this.offset;
    this.offset += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }

  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }

  i32(): number {
    return this.view.getInt32(this.need(4), true);
  }

  f64(): number {
    return this.view.getFloat64(this.need(8), true);
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  /** Octets bruts (copie). */
  bytesValue(): Uint8Array {
    const length = this.u32();
    const at = this.need(length);
    return this.bytes.slice(at, at + length);
  }

  string(): string {
    return decoder.decode(this.bytesValue());
  }

  private typedBytes(bytesPerElement: number): ArrayBuffer {
    const length = this.u32();
    const at = this.need(length * bytesPerElement);
    // Copie dans un tampon neuf : alignement garanti pour la vue typée.
    return this.bytes.slice(at, at + length * bytesPerElement).buffer;
  }

  uint8Array(): Uint8Array {
    return new Uint8Array(this.typedBytes(1));
  }
  int8Array(): Int8Array {
    return new Int8Array(this.typedBytes(1));
  }
  uint16Array(): Uint16Array {
    return new Uint16Array(this.typedBytes(2));
  }
  int16Array(): Int16Array {
    return new Int16Array(this.typedBytes(2));
  }
  uint32Array(): Uint32Array {
    return new Uint32Array(this.typedBytes(4));
  }
  int32Array(): Int32Array {
    return new Int32Array(this.typedBytes(4));
  }
  float32Array(): Float32Array {
    return new Float32Array(this.typedBytes(4));
  }
  float64Array(): Float64Array {
    return new Float64Array(this.typedBytes(8));
  }
}
