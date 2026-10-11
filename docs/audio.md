# Son

`@gamecore/audio` fabrique tout le son à la volée avec la Web Audio API : **aucun fichier audio**, donc rien à
télécharger, et rien qui pose problème de droits quand le jeu est streamé. Le moteur vient de DCDS et a été rendu
générique.

## Mise en place

```ts
// audio.ts — un moteur par jeu (la clé sert à mémoriser les réglages du joueur)
import { createAudioEngine } from "@gamecore/audio";
export const audio = createAudioEngine({ storageKey: "mon-jeu-audio" });
```

```tsx
import { AudioProvider, SoundControls, useMusicMood, useSfx } from "@gamecore/audio/react";

<AudioProvider engine={audio} clickSelector=".btn">
  {" "}
  {/* clic sonore sur les boutons .btn */}
  <App />
  <SoundControls /> {/* bouton 🔊 : volumes, coupure */}
</AudioProvider>;

function Plateau() {
  useMusicMood("game"); // ambiance tant que le composant est affiché
  const play = useSfx();
  return <button onClick={() => play("success")}>Gagné !</button>;
}
```

`AudioProvider` :

- débloque le son au **premier geste** (clic, touche, toucher) : les navigateurs interdisent le son avant, et le moteur
  ne crée aucun contexte audio d'ici là ;
- coupe et rétablit tout avec la touche **M** (sauf pendant une saisie) ;
- se tait quand l'onglet passe en arrière-plan.

`SoundControls` est accessible (`aria-expanded`, Échap pour fermer) et non stylé : habille les classes `gc-sound*`
(voir `styles.css` du Buzzer).

## Bruitages fournis

| Famille    | Noms                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Interface  | `click`, `pop`, `join`, `leave`, `chat`, `error`, `whoosh`                                       |
| Partie     | `start`, `round`, `myTurn`, `done`, `open`, `lock`, `designate`, `rouletteTick`, `alarm`, `calm` |
| Temps      | `tick`, `timeout`                                                                                |
| Révélation | `drumroll`, `fail`, `meh`, `success`, `fanfare`, `jackpot`, `applause`, `victory`                |

Options : `play("drumroll", { duration: 2 })`, `play("rouletteTick", { pitch: 1.3 })`, `play("click", { delay: 0.2 })`.

## Ambiances musicales

| Ambiance   | Pour                                      |
| ---------- | ----------------------------------------- |
| `lobby`    | Accueil, salon d'attente (lounge doux)    |
| `game`     | Partie (marimba bondissant)               |
| `suspense` | Moment décisif (ostinato, tic-tac)        |
| `reveal`   | Révélation (battements de cœur)           |
| `victory`  | Fin de partie (cuivres, applaudissements) |

Un changement d'ambiance attend la mesure suivante, pour rester en rythme. `useMusicMood(null)` (ou le démontage du
composant) arrête la musique.

## Sons propres au jeu

```ts
import { createAudioEngine, synth } from "@gamecore/audio";

export const audio = createAudioEngine({
  storageKey: "mon-jeu-audio",
  sfx: {
    // Une recette joue des notes à partir de la date `t` (horloge audio), avec les instruments fournis.
    pioche: (kit, t) => {
      synth.whoosh(kit, t, 0.2, 800, 3000, 0.08);
      synth.marimba(kit, t + 0.1, 76, 0.2);
    },
  },
  moods: {
    calme: { bpm: 70, level: 0.6, step: (kit, bar, step, t) => step === 0 && synth.ep(kit, t, 60, 0.08, 2) },
  },
});
audio.play("pioche"); // typé : bruitages fournis + bruitages du jeu
```

Instruments disponibles dans `synth` : `marimba`, `pluck`, `bass`, `ep` (piano électrique), `lead`, `bell`, `pad`,
`brass`, `choir`, `trombone`, `kick`, `snare`, `clap`, `hat`, `shaker`, `woodblock`, `crash`, `timpani`, `whoosh`,
`blip`, `drumroll`, `siren`, `buzzer`, `applause`, `creak` (hauteurs en notes MIDI : 60 = do central).

## Bonnes pratiques

- **Secret et micros** : un son joué chez un joueur passe dans son micro (vocal Discord, stream). Un évènement privé
  (« tu as pioché la meilleure carte ») doit avoir un son **neutre** ; les sons expressifs sont pour les évènements
  publics (révélation, fin de manche).
- **Musique sur l'écran partagé, discrétion sur les téléphones** : dans le Buzzer, l'écran de l'hôte porte la musique et
  les bruitages publics ; les téléphones jouent un son neutre quand on répond, puis le résultat une fois révélé.
- **Atténuation** : `audio.setDuck(true)` baisse la musique pendant que quelqu'un parle (branché sur la détection de
  parole de LiveKit).

## Tester

`@gamecore/audio/testing` fournit un faux `AudioContext` **strict** (il lève les mêmes erreurs que les navigateurs :
rampe exponentielle vers 0, date non finie, `stop()` avant `start()`) et garde la trace des sons programmés :

```ts
import { FakeAudioContext } from "@gamecore/audio/testing";

const ctx = new FakeAudioContext();
const engine = createAudioEngine({ storageKey: "t", createContext: () => ctx as never, storage: null });
engine.unlock();
engine.play("pioche");
expect(ctx.starts.length).toBeGreaterThan(0);
```

Les tests de bout en bout ([`e2e/audio.spec.ts`](../e2e/audio.spec.ts)) vérifient qu'aucun contexte audio n'est créé
avant un geste, qu'il n'y en a qu'un ensuite, et que la coupure et les volumes sont mémorisés.
