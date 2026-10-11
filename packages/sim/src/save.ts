/**
 * Format de sauvegarde binaire `GCSIM`.
 *
 * Disposition (petit-boutiste ; « chaîne » = u32 longueur + UTF-8, « octets » = u32 + données) :
 *
 *   "GCSIM"        5 octets ASCII
 *   u8             version du format d'en-tête (1)
 *   chaîne         id de la simulation
 *   u32            version du format d'état (`definition.version` au moment de la sauvegarde)
 *   u32            tick (ticks terminés)
 *   u32 × 4        état du RNG
 *   chaîne         réglages (JSON)
 *   u8 + chaîne    graine (présente ou non)
 *   u32            dernier numéro de commande (`seq`)
 *   u32            premier tick couvert par le journal (`journalFrom`)
 *   u32            nombre d'entrées du journal
 *   chaîne         journal (JSON : [[tick, seq, commande], …])
 *   chaîne         commandes programmées (JSON : [[clé, échéance, commande], …])
 *   chaîne         hash de la simulation au moment de la sauvegarde
 *   octets         état : `codec.encode(state)`
 *
 * Un fichier chargé peut venir de n'importe où (téléchargement, partage) : tout est relu
 * strictement (taille bornée, JSON revalidé par zod et par les schémas de la définition,
 * cohérence des ticks), et toute anomalie lève un `GameError("BAD_REQUEST")`.
 */

import { GameError, type RngState } from "@gamecore/core";
import { z } from "zod";
import { ByteReader, ByteWriter } from "./bytes.js";
import type { AnySimulation, SimTypes } from "./definition.js";
import type { JournalEntry, ScheduledCommand } from "./simulation.js";

const MAGIC = "GCSIM";
const FORMAT = 1;

/** Contenu d'une sauvegarde. */
export interface SimSave<D extends AnySimulation = AnySimulation> {
  readonly id: string;
  /** Version du format d'état dans le fichier (avant migration). */
  readonly savedVersion: number;
  readonly tick: number;
  readonly rng: RngState;
  readonly settings: SimTypes<D>["settings"];
  readonly seed: string | null;
  readonly seq: number;
  /** Premier tick couvert par le journal (0 : depuis le début). */
  readonly journalFrom: number;
  readonly journal: readonly JournalEntry<SimTypes<D>["command"]>[];
  readonly scheduled: readonly ScheduledCommand<SimTypes<D>["systemCommand"]>[];
  /** Hash de la simulation au moment de la sauvegarde. */
  readonly hash: string;
  /** État décodé (après migrations éventuelles). */
  readonly state: SimTypes<D>["state"];
}

/** Ce qu'il faut écrire (l'état est encodé par le `codec` de la définition). */
export type SimSaveInput<D extends AnySimulation = AnySimulation> = Omit<SimSave<D>, "savedVersion">;

export interface DecodeSaveOptions {
  /** Taille maximale acceptée, en octets (64 Mio par défaut). */
  maxBytes?: number;
  /** Entrées de journal acceptées au plus (1 000 000 par défaut). */
  maxJournalEntries?: number;
}

const u32 = z.number().int().min(0).max(0xffffffff);
const journalSchema = z.array(z.tuple([u32.min(1), u32.min(1), z.unknown()]));
const scheduledSchema = z.array(z.tuple([z.string().min(1).max(64), u32.min(1), z.unknown()]));

const bad = (message: string) => new GameError("BAD_REQUEST", message);

/** Écrit une sauvegarde. */
export function writeSave<D extends AnySimulation>(definition: D, save: SimSaveInput<D>): Uint8Array {
  const body = definition.codec.encode(save.state);
  if (!(body instanceof Uint8Array)) throw new TypeError("codec.encode doit renvoyer un Uint8Array.");
  const w = new ByteWriter(body.length + 1024);
  for (let i = 0; i < MAGIC.length; i++) w.u8(MAGIC.charCodeAt(i));
  w.u8(FORMAT);
  w.string(definition.id);
  w.u32(definition.version);
  w.u32(save.tick);
  for (const word of save.rng) w.u32(word);
  w.string(JSON.stringify(save.settings));
  w.bool(save.seed !== null);
  if (save.seed !== null) w.string(save.seed);
  w.u32(save.seq);
  w.u32(save.journalFrom);
  w.u32(save.journal.length);
  w.string(JSON.stringify(save.journal.map((e) => [e.tick, e.seq, e.command])));
  w.string(JSON.stringify(save.scheduled.map((s) => [s.key, s.due, s.command])));
  w.string(save.hash);
  w.bytes(body);
  return w.finish();
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw bad(`Sauvegarde invalide : ${what} illisible.`);
  }
}

/** Applique les migrations en chaîne, de `from` jusqu'à `definition.version`. */
function migrateState(definition: AnySimulation, from: number, bytes: Uint8Array): Uint8Array {
  let current = bytes;
  for (let v = from; v < definition.version; v++) {
    const step = definition.migrate?.[v];
    if (!step) throw bad(`Sauvegarde en version ${from} : aucune migration depuis la version ${v}.`);
    try {
      current = step(current);
    } catch (err) {
      throw bad(
        `Migration depuis la version ${v} impossible : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return current;
}

/**
 * Lit et revalide une sauvegarde. Les réglages sont fusionnés avec les valeurs par défaut
 * actuelles puis validés par la fonction `resolveSettings` fournie par l'hôte.
 *
 * Quand une migration s'applique, le journal est abandonné (`journalFrom` = tick + 1) : ses
 * commandes suivaient des règles antérieures et ne sont plus rejouables.
 */
export function readSave<D extends AnySimulation>(
  definition: D,
  bytes: Uint8Array,
  resolveSettings: (settings: unknown) => SimTypes<D>["settings"],
  options: DecodeSaveOptions = {},
): SimSave<D> {
  if (!(bytes instanceof Uint8Array)) throw bad("Sauvegarde invalide : octets attendus.");
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (bytes.length > maxBytes) throw bad("Sauvegarde trop volumineuse.");
  const maxJournal = options.maxJournalEntries ?? 1_000_000;

  try {
    const r = new ByteReader(bytes);
    let magic = "";
    for (let i = 0; i < MAGIC.length; i++) magic += String.fromCharCode(r.u8());
    if (magic !== MAGIC) throw bad("Ce fichier n'est pas une sauvegarde de simulation.");
    const format = r.u8();
    if (format !== FORMAT) throw bad(`Format de sauvegarde ${format} non pris en charge.`);
    const id = r.string();
    if (id !== definition.id) throw bad(`Sauvegarde d'une autre simulation (« ${id.slice(0, 32)} »).`);
    const savedVersion = r.u32();
    if (savedVersion < 1) throw bad("Version de sauvegarde invalide.");
    if (savedVersion > definition.version) {
      throw bad(
        `Sauvegarde en version ${savedVersion}, plus récente que la simulation (${definition.version}).`,
      );
    }
    const tick = r.u32();
    const rng = [r.u32(), r.u32(), r.u32(), r.u32()] as const;
    const settings = resolveSettings(parseJson(r.string(), "réglages"));
    const seed = r.bool() ? r.string() : null;
    if (seed !== null && seed.length > 256) throw bad("Sauvegarde invalide : graine trop longue.");
    const seq = r.u32();
    let journalFrom = r.u32();
    const journalCount = r.u32();
    if (journalCount > maxJournal) throw bad("Sauvegarde invalide : journal trop long.");
    const rawJournal = journalSchema.safeParse(parseJson(r.string(), "journal"));
    if (!rawJournal.success || rawJournal.data.length !== journalCount)
      throw bad("Sauvegarde invalide : journal.");
    const rawScheduled = scheduledSchema.safeParse(parseJson(r.string(), "commandes programmées"));
    if (!rawScheduled.success) throw bad("Sauvegarde invalide : commandes programmées.");
    const hash = r.string();
    if (!/^[0-9a-f]{16}$/.test(hash)) throw bad("Sauvegarde invalide : hash.");
    let body = r.bytesValue();
    if (r.remaining !== 0) throw bad("Sauvegarde invalide : données en trop.");

    if (journalFrom > tick + 1) throw bad("Sauvegarde invalide : début du journal.");
    let journal: JournalEntry<SimTypes<D>["command"]>[] = [];
    if (savedVersion === definition.version) {
      let lastTick = Math.max(1, journalFrom);
      let lastSeq = 0;
      for (const [entryTick, entrySeq, command] of rawJournal.data) {
        if (entryTick < lastTick || entryTick > tick || entrySeq <= lastSeq || entrySeq > seq) {
          throw bad("Sauvegarde invalide : journal incohérent.");
        }
        const parsed = definition.commands.safeParse(command);
        if (!parsed.success) throw bad("Sauvegarde invalide : commande du journal.");
        journal.push({ tick: entryTick, seq: entrySeq, command: parsed.data as SimTypes<D>["command"] });
        lastTick = entryTick;
        lastSeq = entrySeq;
      }
    } else {
      journal = [];
      journalFrom = tick + 1;
      body = migrateState(definition, savedVersion, body);
    }

    const keys = new Set<string>();
    const scheduled: ScheduledCommand<SimTypes<D>["systemCommand"]>[] = [];
    for (const [key, due, command] of rawScheduled.data) {
      if (due <= tick || keys.has(key))
        throw bad("Sauvegarde invalide : commandes programmées incohérentes.");
      const parsed = definition.systemCommands?.safeParse(command);
      if (!parsed?.success) throw bad("Sauvegarde invalide : commande programmée.");
      keys.add(key);
      scheduled.push({ key, due, command: parsed.data as SimTypes<D>["systemCommand"] });
    }

    let state: SimTypes<D>["state"];
    try {
      state = definition.codec.decode(body, definition.version) as SimTypes<D>["state"];
    } catch (err) {
      throw bad(`État illisible : ${err instanceof Error ? err.message : String(err)}`);
    }
    return { id, savedVersion, tick, rng, settings, seed, seq, journalFrom, journal, scheduled, hash, state };
  } catch (err) {
    if (err instanceof GameError) throw err;
    if (err instanceof RangeError) throw bad("Sauvegarde tronquée ou invalide.");
    throw err;
  }
}
