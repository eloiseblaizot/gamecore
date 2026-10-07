import { GameError } from "@gamecore/client";
import { isRoomCode, normalizeRoomCode, ROOM_CODE_LENGTH } from "@gamecore/core";
import { useGameClient } from "@gamecore/react";
import { useState, type FormEvent } from "react";
import type { Buzzer } from "../game.js";
import { navigate } from "../router.js";

/** Accueil : créer une partie sur cet écran, ou rejoindre avec un code. */
export function Home() {
  const client = useGameClient<Buzzer>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const welcome = await client.create("screen");
      navigate(`/screen/${welcome.code}`);
    } catch (err) {
      setError(err instanceof GameError ? err.message : "Impossible de créer la partie.");
      setBusy(false);
    }
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeRoomCode(code);
    if (!isRoomCode(normalized)) {
      setError("Ce code ne ressemble pas à un code de partie.");
      return;
    }
    navigate(`/play/${normalized}`);
  };

  return (
    <main className="page page-center home">
      <header className="home-title">
        <h1 className="logo">
          Buzzer<span>!</span>
        </h1>
        <p className="tagline">Le quiz où ton téléphone devient un buzzer.</p>
      </header>

      <div className="home-cards">
        <section className="card" aria-labelledby="create-title">
          <h2 id="create-title">📺 Écran de jeu</h2>
          <p>Lance la partie sur la télé ou l'ordinateur que tout le monde regarde.</p>
          <button className="btn btn-primary btn-big" onClick={() => void create()} disabled={busy}>
            {busy ? "Création…" : "Créer une partie"}
          </button>
        </section>

        <section className="card" aria-labelledby="join-title">
          <h2 id="join-title">📱 Rejoindre</h2>
          <p>Entre le code affiché sur l'écran de jeu (ou scanne le QR code).</p>
          <form onSubmit={join} className="join-form">
            <label className="field">
              <span>Code de la partie</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={ROOM_CODE_LENGTH + 2}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                placeholder="K7QXPB"
                className="code-input"
              />
            </label>
            <button className="btn btn-secondary btn-big" type="submit">
              Rejoindre
            </button>
          </form>
        </section>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer className="footer">
        Un jeu d'exemple propulsé par <strong>gamecore</strong>.
      </footer>
    </main>
  );
}
