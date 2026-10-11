/**
 * Dessin de la grille sur un canvas 2D, hors de React : chaque rafale de ticks apporte une
 * nouvelle grille (canal `grid`, transférée par le Worker) ; on ne garde que la dernière et
 * on la dessine à la prochaine image (`requestAnimationFrame`), une case = un pixel.
 */

import { FOX, RABBIT } from "./simulation";

// Couleurs au format 0xAABBGGRR (pixels lus en Uint32, petit-boutiste).
const rgba = (hex: number) =>
  (0xff000000 | ((hex & 0xff) << 16) | (hex & 0xff00) | ((hex >> 16) & 0xff)) >>> 0;
const PALETTE = new Uint32Array(256).fill(rgba(0x1d3324));
PALETTE[RABBIT] = rgba(0xe8e2d0);
PALETTE[FOX] = rgba(0xf07a2a);

export interface GridRenderer {
  push(cells: Uint8Array): void;
  dispose(): void;
}

export function createGridRenderer(canvas: HTMLCanvasElement): GridRenderer {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D indisponible.");
  let image: ImageData | null = null;
  let pixels = new Uint32Array(0);
  let pending: Uint8Array | null = null;
  let frame = 0;

  const draw = () => {
    frame = 0;
    const cells = pending;
    pending = null;
    if (!cells) return;
    const size = Math.round(Math.sqrt(cells.length));
    if (!image || image.width !== size) {
      canvas.width = size;
      canvas.height = size;
      image = context.createImageData(size, size);
      pixels = new Uint32Array(image.data.buffer);
    }
    for (let i = 0; i < cells.length; i++) pixels[i] = PALETTE[cells[i]!]!;
    context.putImageData(image, 0, 0);
  };

  return {
    push(cells) {
      pending = cells;
      if (frame === 0) frame = requestAnimationFrame(draw);
    },
    dispose() {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
