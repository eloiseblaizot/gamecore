/** Retour de la connexion Discord (web) : échange du code puis retour au jeu. */

import { completeDiscordLogin } from "@gamecore/discord/client";
import { useEffect, useState } from "react";
import { API_PREFIX, savePendingCredential } from "../config.js";
import { navigate } from "../router.js";
import { Notice } from "../ui/Notice.js";

/** Le code d'autorisation est à usage unique : on ne l'échange qu'une fois, même en mode strict. */
let exchange: ReturnType<typeof completeDiscordLogin> | null = null;

export function DiscordCallback() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    exchange ??= completeDiscordLogin({ tokenEndpoint: `${API_PREFIX}/api/discord/token` });
    exchange
      .then(({ accessToken, returnTo }) => {
        savePendingCredential(accessToken);
        navigate(returnTo, { replace: true });
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        exchange = null;
      });
  }, []);

  if (error) return <Notice title="Connexion Discord impossible">{error}</Notice>;
  return (
    <main className="page page-center">
      <p className="loading">Connexion avec Discord…</p>
    </main>
  );
}
