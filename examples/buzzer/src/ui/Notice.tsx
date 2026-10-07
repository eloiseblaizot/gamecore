import type { ReactNode } from "react";
import { navigate } from "../router.js";

/** Page d'information (salon introuvable, expulsion…) avec retour à l'accueil. */
export function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="page page-center">
      <div className="card notice" role="alert">
        <h1>{title}</h1>
        {children}
        <button className="btn btn-primary" onClick={() => navigate("/")}>
          Retour à l'accueil
        </button>
      </div>
    </main>
  );
}

/** Bandeau affiché quand la connexion est perdue. */
export function ConnectionBanner({ status }: { status: string }) {
  if (status !== "reconnecting" && status !== "connecting") return null;
  return (
    <div className="banner" role="status">
      {status === "connecting" ? "Connexion…" : "Connexion perdue, reconnexion en cours…"}
    </div>
  );
}
