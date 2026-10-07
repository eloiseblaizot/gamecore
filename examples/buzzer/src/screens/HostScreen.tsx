/**
 * Écran de l'hôte : ce que tout le monde regarde (télé, PC partagé, stream).
 * Il n'affiche que la vue PUBLIQUE de la partie : aucune réponse avant la révélation.
 */

import type { MemberInfo } from "@gamecore/core";
import {
  JoinQrCode,
  joinUrl,
  useClientState,
  useConnectionStatus,
  useControllerInput,
  useGame,
  useGameClient,
  useIsHost,
  useRoom,
} from "@gamecore/react";
import { useState } from "react";
import type { Buzzer, BuzzerPublic, BuzzerSettings } from "../game.js";
import { REACTIONS, type Reaction } from "../reactions.js";
import { Avatar } from "../ui/Avatar.js";
import { CHOICE_STYLES } from "../ui/choices.js";
import { Countdown } from "../ui/Countdown.js";
import { ConnectionBanner, Notice } from "../ui/Notice.js";
import { enterErrorTitle, useEnterRoom } from "../useEnterRoom.js";

export function HostScreen({ code }: { code: string }) {
  const [enter] = useEnterRoom(code, "screen");
  const status = useConnectionStatus();
  const room = useRoom<Buzzer>();
  const bye = useClientState((s) => s.bye);

  if (enter.status === "error")
    return <Notice title={enterErrorTitle(enter.error)}>{enter.error.message}</Notice>;
  if (bye === "closed") return <Notice title="Partie terminée">Le salon a été fermé.</Notice>;
  if (enter.status !== "ready" || !room) {
    return (
      <main className="page page-center">
        <p className="loading">Connexion à la partie…</p>
      </main>
    );
  }

  return (
    <main className="page screen">
      <ConnectionBanner status={status} />
      <Reactions />
      {room.status === "lobby" ? <Lobby /> : <Stage />}
    </main>
  );
}

// --- Salon d'attente -------------------------------------------------------------

function Lobby() {
  const client = useGameClient<Buzzer>();
  const room = useRoom<Buzzer>()!;
  const isHost = useIsHost();
  const players = room.members.filter((m) => m.role === "player");
  const url = joinUrl(room.code);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<void>) => {
    setError(null);
    fn().catch((err: Error) => setError(err.message));
  };

  return (
    <div className="lobby">
      <section className="lobby-join" aria-label="Rejoindre la partie">
        <h1 className="logo logo-small">
          Buzzer<span>!</span>
        </h1>
        <p className="lobby-hint">Scanne le QR code ou va sur</p>
        <p className="lobby-url">{url.replace(/\/play\/.*/, "")}</p>
        <div className="qr">
          <JoinQrCode url={url} size={220} foreground="#1b1035" background="#ffffff" />
        </div>
        <p className="lobby-hint">Code de la partie</p>
        <p
          className="room-code"
          data-testid="room-code"
          aria-label={`Code de la partie : ${room.code.split("").join(" ")}`}
        >
          {room.code}
        </p>
      </section>

      <section className="lobby-players" aria-labelledby="players-title">
        <h2 id="players-title">
          Joueurs <span className="count">{players.length}</span>
        </h2>
        {players.length === 0 ? (
          <p className="empty">En attente des premiers joueurs…</p>
        ) : (
          <ul className="player-grid">
            {players.map((m) => (
              <PlayerChip
                key={m.id}
                member={m}
                canKick={isHost}
                onKick={() => run(() => client.lobby.kick(m.id))}
              />
            ))}
          </ul>
        )}

        {isHost && (
          <div className="host-controls">
            <Settings settings={room.settings} onChange={(s) => run(() => client.lobby.settings(s))} />
            <button
              className="btn btn-primary btn-big"
              disabled={players.length < room.game.minPlayers}
              onClick={() => run(() => client.lobby.start())}
            >
              Lancer la partie
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

function PlayerChip({
  member,
  canKick,
  onKick,
}: {
  member: MemberInfo;
  canKick: boolean;
  onKick: () => void;
}) {
  return (
    <li className={`player-chip${member.connected ? "" : " is-away"}`}>
      <Avatar name={member.name} avatar={member.avatar} />
      <span className="player-name">{member.name}</span>
      {member.isHost && <span className="badge">host</span>}
      {canKick && (
        <button className="chip-kick" onClick={onKick} aria-label={`Retirer ${member.name}`}>
          ✕
        </button>
      )}
    </li>
  );
}

function Settings({
  settings,
  onChange,
}: {
  settings: BuzzerSettings;
  onChange: (s: Partial<BuzzerSettings>) => void;
}) {
  return (
    <fieldset className="settings">
      <legend>Réglages</legend>
      <label className="field">
        <span>Questions</span>
        <select value={settings.questions} onChange={(e) => onChange({ questions: Number(e.target.value) })}>
          {[3, 5, 10, 15].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Temps pour répondre</span>
        <select value={settings.seconds} onChange={(e) => onChange({ seconds: Number(e.target.value) })}>
          {[10, 15, 20, 30].map((n) => (
            <option key={n} value={n}>
              {n} s
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

// --- Partie ------------------------------------------------------------------------

function Stage() {
  const client = useGameClient<Buzzer>();
  const game = useGame<Buzzer>();
  const room = useRoom<Buzzer>()!;
  const isHost = useIsHost();
  const [error, setError] = useState<string | null>(null);
  if (!game) return null;
  const pub = game.public;
  const players = room.members.filter((m) => pub.scores[m.id] !== undefined);
  const run = (fn: () => Promise<void>) => {
    setError(null);
    fn().catch((err: Error) => setError(err.message));
  };

  if (pub.phase === "podium") {
    return (
      <div className="stage">
        <Podium ranking={pub.ranking} />
        {isHost && (
          <div className="stage-actions">
            <button className="btn btn-primary btn-big" onClick={() => run(() => client.lobby.start())}>
              Rejouer
            </button>
            <button className="btn btn-secondary btn-big" onClick={() => run(() => client.lobby.end())}>
              Retour au salon
            </button>
          </div>
        )}
      </div>
    );
  }

  const last = pub.index + 1 >= pub.total;
  return (
    <div className="stage">
      <header className="stage-header">
        <p className="question-number">
          Question {pub.index + 1} / {pub.total}
        </p>
        {pub.phase === "question" && (
          <Countdown key={pub.index} deadline={pub.deadline} duration={pub.duration} />
        )}
      </header>

      <h1 className="question-text" aria-live="polite">
        {pub.question.text}
      </h1>

      <ol className="answers" aria-label="Réponses possibles">
        {pub.question.choices.map((choice, i) => {
          const style = CHOICE_STYLES[i]!;
          const correct = pub.reveal?.correct === i;
          const dimmed = pub.reveal !== null && !correct;
          return (
            <li
              key={i}
              className={`answer ${style.className}${correct ? " is-correct" : ""}${dimmed ? " is-dimmed" : ""}`}
              aria-label={`Réponse ${style.letter} : ${choice}${correct ? " (bonne réponse)" : ""}`}
            >
              <span className="answer-shape" aria-hidden>
                {style.shape}
              </span>
              <span className="answer-text">{choice}</span>
              {pub.reveal && <span className="answer-count">{pub.reveal.counts[i]}</span>}
            </li>
          );
        })}
      </ol>

      {pub.phase === "question" ? (
        <p className="answered" aria-live="polite" data-testid="answered">
          {pub.answered.length} / {players.length} {pub.answered.length > 1 ? "ont répondu" : "a répondu"}
        </p>
      ) : (
        <Scoreboard pub={pub} players={players} />
      )}

      {isHost && pub.phase === "reveal" && (
        <div className="stage-actions">
          <button className="btn btn-primary btn-big" onClick={() => run(() => client.act({ type: "next" }))}>
            {last ? "Voir le podium" : "Question suivante"}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Scoreboard({ pub, players }: { pub: BuzzerPublic; players: MemberInfo[] }) {
  const byId = new Map(players.map((p) => [p.id, p]));
  return (
    <ol className="scoreboard" aria-label="Classement">
      {pub.ranking.slice(0, 8).map((r) => {
        const gained = pub.reveal?.gained[r.id] ?? 0;
        return (
          <li key={r.id} className={byId.get(r.id)?.connected === false ? "is-away" : undefined}>
            <span className="rank">{r.rank}</span>
            <Avatar name={r.name} avatar={r.avatar} size={36} />
            <span className="player-name">{r.name}</span>
            {gained > 0 && <span className="gained">+{gained}</span>}
            <span className="score">{r.score}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Podium({ ranking }: { ranking: BuzzerPublic["ranking"] }) {
  const medals = ["🥇", "🥈", "🥉"];
  return (
    <section className="podium" aria-labelledby="podium-title">
      <h1 id="podium-title">Podium</h1>
      <ol className="podium-list">
        {ranking.map((r) => (
          <li key={r.id} className={`podium-row rank-${Math.min(r.rank, 4)}`}>
            <span className="medal" aria-hidden>
              {medals[r.rank - 1] ?? r.rank}
            </span>
            <Avatar name={r.name} avatar={r.avatar} size={44} />
            <span className="player-name">{r.name}</span>
            <span className="score">{r.score} pts</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// --- Réactions des téléphones ----------------------------------------------------

interface Floating {
  id: number;
  reaction: Reaction;
  name: string;
  left: number;
}

let reactionSeq = 0;

/** Les emojis envoyés par les téléphones s'envolent sur l'écran (module « controller »). */
function Reactions() {
  const room = useRoom<Buzzer>();
  const [items, setItems] = useState<Floating[]>([]);
  useControllerInput((from, data) => {
    const reaction = (data as { reaction?: string } | null)?.reaction;
    if (!REACTIONS.includes(reaction as Reaction)) return;
    const name = room?.members.find((m) => m.id === from)?.name ?? "";
    const item = { id: ++reactionSeq, reaction: reaction as Reaction, name, left: 5 + Math.random() * 90 };
    setItems((all) => [...all.slice(-30), item]);
    setTimeout(() => setItems((all) => all.filter((i) => i.id !== item.id)), 2600);
  });
  return (
    <div className="reactions" aria-hidden>
      {items.map((i) => (
        <span key={i.id} className="reaction" style={{ left: `${i.left}%` }}>
          {i.reaction}
          <small>{i.name}</small>
        </span>
      ))}
    </div>
  );
}
