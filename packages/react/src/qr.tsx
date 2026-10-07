/**
 * QR code pour rejoindre une partie depuis un téléphone.
 *
 * Le QR code est dessiné en SVG natif (aucun `innerHTML`, aucune image distante) à partir
 * de la matrice calculée par `uqr`. L'URL encodée ne contient que le code du salon —
 * jamais de jeton.
 */

import { useMemo } from "react";
import { encode } from "uqr";

export interface JoinQrCodeProps {
  /** URL à encoder, par exemple `joinUrl(code)`. */
  url: string;
  /** Taille affichée en pixels (200 par défaut). */
  size?: number;
  /** Texte alternatif pour les lecteurs d'écran. */
  label?: string;
  /** Couleur des modules (`currentColor` par défaut) et du fond. */
  foreground?: string;
  background?: string;
  className?: string;
}

/** Chemin SVG (un carré par module noir), calculé une fois par URL. */
export function qrPath(url: string): { size: number; path: string } {
  const qr = encode(url, { ecc: "M", border: 2 });
  let path = "";
  qr.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return { size: qr.size, path };
}

export function JoinQrCode({
  url,
  size = 200,
  label = "QR code pour rejoindre la partie",
  foreground = "currentColor",
  background = "transparent",
  className,
}: JoinQrCodeProps) {
  const qr = useMemo(() => qrPath(url), [url]);
  return (
    <svg
      role="img"
      aria-label={label}
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} fill={background} />
      <path d={qr.path} fill={foreground} />
    </svg>
  );
}

/**
 * URL de connexion d'un téléphone : `https://monjeu.fr/play/K7QXPB`.
 * Par défaut sur la même origine que la page (l'écran de l'hôte).
 */
export function joinUrl(code: string, options: { origin?: string; path?: string } = {}): string {
  const origin = options.origin ?? globalThis.location?.origin ?? "";
  const path = options.path ?? "/play/";
  return `${origin}${path}${encodeURIComponent(code)}`;
}
