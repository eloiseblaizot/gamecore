/**
 * Interface de l'exemple : la grille (canvas, hors de React), la barre de contrôle, les
 * statistiques et les outils de sauvegarde, de chargement et de rejeu.
 */

import { GameError } from "@gamecore/core";
import { decodeSave, replay } from "@gamecore/sim";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { connect, type Connection } from "./connect";
import { createGridRenderer } from "./render";
import { SEASONS, foxesAndRabbits, type EcoStats } from "./simulation";

const SPEEDS = [1, 2, 4] as const;
/** Animaux ajoutés par clic. */
const PER_CLICK = 40;
/** Taille maximale d'une sauvegarde chargée depuis le disque. */
const MAX_SAVE_BYTES = 16 * 1024 * 1024;

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Props {
  /** Simulation dans la page (sans Worker). */
  local: boolean;
  /** Graine imposée par l'adresse (`?seed=`), sinon aléatoire. */
  seed: string | null;
}

export function App({ local, seed }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connectionRef = useRef<Connection | null>(null);
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);
  const [tps, setTps] = useState(0);
  const [lagging, setLagging] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [stats, setStats] = useState<EcoStats | null>(null);
  const [tool, setTool] = useState<"rabbits" | "foxes">("rabbits");
  const [message, setMessage] = useState("Démarrage de la simulation…");
  const [hashes, setHashes] = useState<{ game: string; replay: string; tick: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [gameSeed, setGameSeed] = useState<string | null>(null);

  useEffect(() => {
    const connection = connect(local);
    connectionRef.current = connection;
    const { remote } = connection;
    const renderer = createGridRenderer(canvasRef.current!);
    let lagTimer: ReturnType<typeof setTimeout> | undefined;
    const offs = [
      remote.on("channel:grid", (cells) => renderer.push(cells as Uint8Array)),
      remote.on("channel:stats", (data) => setStats(data as EcoStats)),
      remote.on("snapshot", (snapshot) => {
        if (snapshot.channels.grid) renderer.push(snapshot.channels.grid as Uint8Array);
        if (snapshot.channels.stats) setStats(snapshot.channels.stats as EcoStats);
        setTick(snapshot.tick);
      }),
      remote.on("tick", (info) => {
        setTick(info.tick);
        setTps(info.tps);
      }),
      remote.on("lag", () => {
        setLagging(true);
        clearTimeout(lagTimer);
        lagTimer = setTimeout(() => setLagging(false), 2000);
      }),
      remote.on("event:season", (data) =>
        setMessage(`Nouvelle saison : ${(data as { name: string }).name}.`),
      ),
      remote.on("commandRejected", (rejection) => setMessage(`Commande refusée : ${rejection.message}`)),
      remote.on("corrupted", (info) =>
        setMessage(`Simulation arrêtée (erreur dans ${info.system}) : ${info.cause}`),
      ),
      remote.on("error", (err) => setMessage(`Erreur : ${err.message}`)),
    ];
    remote
      .init({ seed: seed?.slice(0, 64) || undefined })
      .then((info) => {
        setReady(true);
        setGameSeed(info.seed);
        setMessage(`Simulation prête (${connection.mode === "worker" ? "Web Worker" : "dans la page"}).`);
      })
      .catch((err: unknown) => setMessage(`Impossible de démarrer : ${describe(err)}`));
    return () => {
      offs.forEach((off) => off());
      clearTimeout(lagTimer);
      renderer.dispose();
      connection.close();
      connectionRef.current = null;
    };
  }, [local, seed]);

  const remote = () => connectionRef.current!.remote;

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (err) {
      setMessage(err instanceof GameError ? `Refusé : ${err.message}` : `Erreur : ${describe(err)}`);
    }
  };

  const changeSpeed = (next: number) =>
    run(async () => {
      if (next === 0) {
        await remote().pause();
      } else {
        await remote().setSpeed(next);
        await remote().resume();
      }
      setSpeed(next);
    });

  const onGridClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height);
    const command =
      tool === "rabbits"
        ? ({ type: "addRabbits", x, y, count: PER_CLICK } as const)
        : ({ type: "addFoxes", x, y, count: PER_CLICK } as const);
    void run(() => remote().dispatch(command));
  };

  const save = () =>
    run(async () => {
      const bytes = await remote().save();
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `renards-et-lapins-tick-${decodeSave(foxesAndRabbits, bytes).tick}.gcsim`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Sauvegarde téléchargée.");
    });

  const load = (file: File | undefined) =>
    run(async () => {
      if (!file) return;
      if (file.size > MAX_SAVE_BYTES) throw new Error("fichier trop volumineux.");
      const info = await remote().load(new Uint8Array(await file.arrayBuffer()), {
        speed: speed === 0 ? 1 : speed,
        paused: speed === 0,
      });
      setTick(info.tick);
      setGameSeed(info.seed);
      setHashes(null);
      setMessage(`Sauvegarde chargée (tick ${info.tick}).`);
    });

  const replayGame = () =>
    run(async () => {
      setBusy(true);
      try {
        // On sauvegarde la partie, puis on la recrée depuis sa graine et son journal.
        const saved = decodeSave(foxesAndRabbits, await remote().save());
        if (saved.seed === null || saved.journalFrom !== 0) {
          throw new Error("le journal de cette partie est incomplet (sauvegarde migrée ou compactée).");
        }
        const replayed = replay(foxesAndRabbits, {
          seed: saved.seed,
          settings: saved.settings,
          journal: saved.journal,
          untilTick: saved.tick,
        });
        setHashes({ game: saved.hash, replay: replayed.hash(), tick: saved.tick });
        setMessage(`Partie rejouée jusqu'au tick ${saved.tick} (${saved.journal.length} commandes).`);
      } finally {
        setBusy(false);
      }
    });

  const target = 10 * speed;
  return (
    <div className="app">
      <header>
        <h1>Renards et lapins</h1>
        <p className="subtitle">
          Un écosystème simulé par <code>@gamecore/sim</code>. Cliquez sur la grille pour ajouter des animaux.
        </p>
      </header>

      <main>
        <section className="board">
          <canvas
            ref={canvasRef}
            className="grid"
            width={128}
            height={128}
            aria-label="Grille de la simulation"
            onClick={onGridClick}
          />
          <div className="legend">
            <span className="swatch rabbit" /> lapins <span className="swatch fox" /> renards
          </div>
        </section>

        <aside className="panel">
          <div className="controls" role="group" aria-label="Vitesse">
            <button
              type="button"
              aria-pressed={speed === 0}
              disabled={!ready}
              onClick={() => void changeSpeed(0)}
            >
              Pause
            </button>
            {SPEEDS.map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={speed === value}
                disabled={!ready}
                onClick={() => void changeSpeed(value)}
              >
                ×{value}
              </button>
            ))}
            <button
              type="button"
              disabled={!ready || speed !== 0}
              onClick={() => void run(() => remote().step(1))}
            >
              Pas à pas
            </button>
          </div>

          <dl className="stats">
            <dt>Tick</dt>
            <dd data-testid="tick">{tick}</dd>
            <dt>Ticks/s</dt>
            <dd>
              {speed === 0 ? (
                "en pause"
              ) : (
                <>
                  <span data-testid="tps">{tps.toFixed(1)}</span> réels / {target} visés
                </>
              )}
              {lagging && <span className="badge lag">en retard</span>}
            </dd>
            <dt>Saison</dt>
            <dd>{stats ? SEASONS[stats.season] : "—"}</dd>
            <dt>Lapins</dt>
            <dd data-testid="rabbits">{stats?.rabbits ?? "—"}</dd>
            <dt>Renards</dt>
            <dd data-testid="foxes">{stats?.foxes ?? "—"}</dd>
            <dt>Graine</dt>
            <dd className="mono">{gameSeed ?? "—"}</dd>
          </dl>

          <fieldset className="tool">
            <legend>Un clic ajoute</legend>
            <label>
              <input
                type="radio"
                name="tool"
                checked={tool === "rabbits"}
                onChange={() => setTool("rabbits")}
              />{" "}
              {PER_CLICK} lapins
            </label>
            <label>
              <input type="radio" name="tool" checked={tool === "foxes"} onChange={() => setTool("foxes")} />{" "}
              {PER_CLICK} renards
            </label>
          </fieldset>

          <div className="files">
            <button type="button" disabled={!ready} onClick={() => void save()}>
              Sauvegarder
            </button>
            <label className="file">
              Charger une sauvegarde
              <input
                type="file"
                accept=".gcsim,application/octet-stream"
                disabled={!ready}
                onChange={(event) => {
                  void load(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button type="button" disabled={!ready || busy} onClick={() => void replayGame()}>
              Rejouer
            </button>
          </div>

          {hashes && (
            <div className="hashes" aria-label="Comparaison des hashs">
              <div>
                <span>Partie (tick {hashes.tick})</span>
                <code data-testid="hash-game">{hashes.game}</code>
              </div>
              <div>
                <span>Rejeu</span>
                <code data-testid="hash-replay">{hashes.replay}</code>
              </div>
              <p className={hashes.game === hashes.replay ? "ok" : "ko"}>
                {hashes.game === hashes.replay
                  ? "Identiques : la simulation est déterministe."
                  : "Différents !"}
              </p>
            </div>
          )}

          <p className="message" role="status" aria-live="polite">
            {message}
          </p>
        </aside>
      </main>
    </div>
  );
}
