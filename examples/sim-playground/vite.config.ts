import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, type Plugin } from "vite";

/** Port de `vite preview` (utilisé par les tests de bout en bout). */
const previewPort = Number(process.env.PORT ?? 4175);

/**
 * Politique de sécurité du contenu, ajoutée au build seulement (le serveur de développement
 * de Vite injecte des scripts en ligne). Aucun script tiers, aucune connexion sortante.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: policy },
        injectTo: "head-prepend",
      },
    ],
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  resolve: {
    // Les paquets @gamecore/* sont lus depuis leurs sources : pas de build à lancer avant.
    conditions: ["source", ...defaultClientConditions],
  },
  worker: {
    format: "es",
  },
  build: {
    sourcemap: false,
  },
  preview: {
    port: previewPort,
    strictPort: true,
  },
});
