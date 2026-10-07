/**
 * Manette : le téléphone d'un joueur. Il affiche la vue publique ET la vue privée du
 * joueur (sa réponse, ses points), et envoie ses actions au serveur.
 */

import { GameError } from "@gamecore/client";
import { DISPLAY_NAME_MAX_LENGTH } from "@gamecore/core";
import {
  ControllerButton,
  useClientState,
  useConnectionStatus,
  useGame,
  useGameClient,
  useIsHost,
  useMe,
  useRoom,
  useWakeLock,
  vibrate,
} from "@gamecore/react";
import { useState, type FormEvent } from "react";
import type { Buzzer, Choice } from "../game.js";
import { REACTIONS } from "../reactions.js";
import { navigate } from "../router.js";
import { Avatar } from "../ui/Avatar.js";
import { CHOICE_STYLES } from "../ui/choices.js";
import { Countdown } from "../ui/Countdown.js";
import { ConnectionBanner, Notice } from "../ui/Notice.js";
import { enterErrorTitle, useEnterRoom } from "../useEnterRoom.js";

const AVATARS = ["🦊", "🐼", "🐸", "🦄", "🐙", "🐯", "🐧", "🦖", "🐝", "🦉", "🐶", "🐱"];

export function Phone({ code }: { code: string }) {
  const [enter, setEnter] = useEnterRoom(code, "player");
  const status = useConnectionStatus();
  const room = useRoom<Buzzer>();
  const bye = useClientState((s) => s.bye);
  // L'écran reste allumé pendant toute la partie.
  useWakeLock(enter.status === "ready");

  if (bye === "kicked")
    return <Notice title="Tu as été retiré de la partie">L'host t'a retiré du salon.</Notice>;
  if (bye === "closed") return <Notice title="Partie terminée">Le salon a été fermé.</Notice>;
  if (bye === "replaced")
    return <Notice title="Partie ouverte ailleurs">Tu joues maintenant depuis un autre onglet.</Notice>;
  if (enter.status === "error")
    return <Notice title={enterErrorTitle(enter.error)}>{enter.error.message}</Notice>;
  if (enter.status === "needs-join")
    return <JoinForm code={code} onJoined={() => setEnter({ status: "ready" })} />;
  if (enter.status !== "ready" || !room) {
    return (
      <main className="page page-center">
        <p className="loading">Connexion à la partie…</p>
      </main>
    );
  }
  return (
    <main className="page phone">
      <ConnectionBanner status={status} />
      <PhoneHeader />
      {room.status === "lobby" ? <Waiting /> : <Controller />}
      <ReactionBar />
    </main>
  );
}

// --- Entrée dans la partie ---------------------------------------------------------

function JoinForm({ code, onJoined }: { code: string; onJoined: () => void }) {
  const client = useGameClient<Buzzer>();
  const [name, setName] = useState("");
  // Initialiseur paresseux : le tirage n'a lieu qu'une fois, au montage.
  const [avatar, setAvatar] = useState(() => AVATARS[Math.floor(Math.random() * AVATARS.length)]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GameError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.join(code, { name, avatar });
      onJoined();
    } catch (err) {
      setError(err instanceof GameError ? err : new GameError("INTERNAL", "Impossible de rejoindre."));
      setBusy(false);
    }
  };

  if (error && ["NOT_FOUND", "RATE_LIMITED"].includes(error.code)) {
    return <Notice title={enterErrorTitle(error)}>{error.message}</Notice>;
  }
  return (
    <main className="page page-center">
      <form className="card join-card" onSubmit={(e) => void submit(e)}>
        <h1>
          Partie <span className="code-inline">{code}</span>
        </h1>
        <label className="field">
          <span>Ton pseudo</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            autoComplete="nickname"
            required
            autoFocus
          />
        </label>
        <fieldset className="avatar-picker">
          <legend>Ton avatar</legend>
          {AVATARS.map((a) => (
            <button
              key={a}
              type="button"
              className={a === avatar ? "is-selected" : undefined}
              aria-pressed={a === avatar}
              aria-label={`Avatar ${a}`}
              onClick={() => setAvatar(a)}
            >
              {a}
            </button>
          ))}
        </fieldset>
        <button className="btn btn-primary btn-big" type="submit" disabled={busy || name.trim() === ""}>
          {busy ? "Connexion…" : "C'est parti !"}
        </button>
        {error && (
          <p className="error" role="alert">
            {error.message}
          </p>
        )}
      </form>
    </main>
  );
}

// --- En jeu ------------------------------------------------------------------------

function PhoneHeader() {
  const me = useMe();
  const game = useGame<Buzzer>();
  if (!me) return null;
  const score = game?.public.scores[me.id];
  return (
    <header className="phone-header">
      <Avatar name={me.name} avatar={me.avatar} size={36} />
      <span className="player-name">{me.name}</span>
      {score !== undefined && (
        <span className="score" data-testid="my-score">
          {score} pts
        </span>
      )}
    </header>
  );
}

function Waiting() {
  const client = useGameClient<Buzzer>();
  const room = useRoom<Buzzer>()!;
  const me = useMe();
  const isHost = useIsHost();
  const [error, setError] = useState<string | null>(null);
  const players = room.members.filter((m) => m.role === "player").length;

  return (
    <section className="phone-panel" aria-live="polite">
      <h1>C'est bon{me ? `, ${me.name}` : ""} !</h1>
      <p>Regarde l'écran de jeu : la partie va bientôt commencer.</p>
      <p className="muted">
        {players} joueur{players > 1 ? "s" : ""} dans la partie
      </p>
      {me?.role === "spectator" && <p className="muted">Tu es spectateur : la partie est complète.</p>}
      {isHost && (
        <button
          className="btn btn-primary btn-big"
          onClick={() => void client.lobby.start().catch((err: Error) => setError(err.message))}
        >
          Lancer la partie
        </button>
      )}
      <button className="btn btn-ghost" onClick={() => void client.leave().finally(() => navigate("/"))}>
        Quitter
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Controller() {
  const client = useGameClient<Buzzer>();
  const game = useGame<Buzzer>();
  const me = useMe();
  const isHost = useIsHost();
  const [error, setError] = useState<string | null>(null);
  if (!game || !me) return null;
  const { public: pub, private: mine } = game;

  if (me.role === "spectator" || !mine) {
    return (
      <section className="phone-panel">
        <h1>Tu regardes la partie</h1>
        <p>
          Question {pub.index + 1} / {pub.total}
        </p>
      </section>
    );
  }

  if (pub.phase === "podium") {
    const rank = pub.ranking.find((r) => r.id === me.id)?.rank ?? pub.ranking.length;
    return (
      <section className="phone-panel" aria-live="polite">
        <p className="big-emoji" aria-hidden>
          {rank === 1 ? "🏆" : rank <= 3 ? "🎉" : "👏"}
        </p>
        <h1 data-testid="final-rank">
          {rank === 1 ? "1re place !" : `${rank}e place`} sur {pub.ranking.length}
        </h1>
        {isHost && (
          <button className="btn btn-primary btn-big" onClick={() => void client.lobby.start()}>
            Rejouer
          </button>
        )}
      </section>
    );
  }

  if (pub.phase === "reveal" && mine.result) {
    const correct = pub.reveal!.correct;
    return (
      <section
        className={`phone-panel result ${mine.result.correct ? "is-win" : "is-lose"}`}
        aria-live="polite"
      >
        <p className="big-emoji" aria-hidden>
          {mine.result.correct ? "✅" : "❌"}
        </p>
        <h1 data-testid="result">
          {mine.result.correct ? `Bonne réponse ! +${mine.result.gained}` : "Raté !"}
        </h1>
        {!mine.result.correct && (
          <p>
            C'était {CHOICE_STYLES[correct].letter} : {pub.question.choices[correct]}
          </p>
        )}
        {isHost && (
          <button className="btn btn-primary btn-big" onClick={() => void client.act({ type: "next" })}>
            {pub.index + 1 >= pub.total ? "Voir le podium" : "Question suivante"}
          </button>
        )}
      </section>
    );
  }

  if (mine.myAnswer !== null) {
    const style = CHOICE_STYLES[mine.myAnswer];
    return (
      <section className="phone-panel" aria-live="polite">
        <p className={`picked ${style.className}`} aria-hidden>
          {style.shape}
        </p>
        <h1 data-testid="answer-sent">Réponse envoyée !</h1>
        <p className="muted">Attends les autres joueurs…</p>
      </section>
    );
  }

  const answer = (choice: Choice) => {
    setError(null);
    vibrate(30);
    client.act({ type: "answer", choice }).catch((err: Error) => setError(err.message));
  };

  return (
    <section className="buzzers" aria-label={`Question ${pub.index + 1} : ${pub.question.text}`}>
      <div className="phone-question">
        <Countdown deadline={pub.deadline} duration={pub.duration} size={56} />
        <p>{pub.question.text}</p>
      </div>
      <div className="buzzer-grid">
        {pub.question.choices.map((choice, i) => {
          const style = CHOICE_STYLES[i]!;
          return (
            <ControllerButton
              key={i}
              className={`buzzer ${style.className}`}
              onPress={() => answer(i as Choice)}
              haptic={0}
              aria-label={`Réponse ${style.letter} : ${choice}`}
            >
              <span className="answer-shape" aria-hidden>
                {style.shape}
              </span>
              <span className="buzzer-text">{choice}</span>
            </ControllerButton>
          );
        })}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Réactions envoyées à l'écran (module « controller », sans réponse du serveur). */
function ReactionBar() {
  const client = useGameClient<Buzzer>();
  return (
    <nav className="reaction-bar" aria-label="Réactions">
      {REACTIONS.map((reaction) => (
        <button
          key={reaction}
          onClick={() => client.sendInput({ reaction })}
          aria-label={`Réagir ${reaction}`}
        >
          {reaction}
        </button>
      ))}
    </nav>
  );
}
