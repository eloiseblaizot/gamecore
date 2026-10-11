/**
 * Page du mode démo : l'écran de l'hôte et le téléphone du joueur côte à côte, tous deux
 * branchés sur un serveur gamecore qui tourne dans la page (transport local), avec des bots.
 */

import { LocalMedia } from "@gamecore/livekit/react";
import { GameProvider } from "@gamecore/react";
import { useEffect, useState } from "react";
import type { Demo as DemoRoom } from "../demo.js";
import { navigate } from "../router.js";
import { Notice } from "../ui/Notice.js";
import { HostScreen } from "./HostScreen.js";
import { Phone } from "./Phone.js";

export function Demo() {
  const [demo, setDemo] = useState<DemoRoom | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current: DemoRoom | null = null;
    let alive = true;
    import("../demo.js")
      .then(({ startDemo }) => startDemo("Toi"))
      .then((room) => {
        current = room;
        if (alive) setDemo(room);
        else room.close();
      })
      .catch(() => alive && setError("Impossible de lancer la démo."));
    return () => {
      alive = false;
      current?.close();
    };
  }, []);

  if (error) return <Notice title="Démo indisponible">{error}</Notice>;
  if (!demo?.screen) {
    return (
      <main className="page page-center">
        <p className="loading">Préparation de la démo…</p>
      </main>
    );
  }
  return (
    // La webcam locale (facultative) est partagée par l'écran et le téléphone de la démo.
    <LocalMedia memberId={demo.player.getState().session?.memberId ?? null}>
      <div className="demo">
        <header className="demo-bar">
          <p>
            <strong>Mode démo</strong> — tout se passe dans ton navigateur : tu joues contre des bots.
          </p>
          <button className="btn btn-ghost" onClick={() => navigate("/")}>
            Quitter la démo
          </button>
        </header>
        <section className="demo-screen" aria-label="Écran de jeu">
          <GameProvider client={demo.screen}>
            <HostScreen code={demo.code} demo />
          </GameProvider>
        </section>
        <section className="demo-phone" aria-label="Ton téléphone">
          <GameProvider client={demo.player}>
            <Phone code={demo.code} />
          </GameProvider>
        </section>
      </div>
    </LocalMedia>
  );
}
