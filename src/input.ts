import { parseCsv } from './csv.js';
import { InputError } from './errors.js';
import { CONDITIONS, type Condition, type EventMeaning, lookupEvent, normaliseEvent } from './vocabulary.js';

/** One row of the event log. */
export interface MeterEvent {
  /** 1-based line number in the file (header is row 1). */
  row: number;
  meter: string;
  /** Timestamp as written. */
  stamp: string;
  /** Milliseconds; zone-less stamps are compared as they are (like UTC). */
  ms: number;
  /** Event text or code as written. */
  event: string;
  /** Phase as written ('' when there is no phase column or the cell is empty). */
  phase: string;
  /** Meaning from the --map file or the built-in vocabulary; undefined = unknown event. */
  meaning?: EventMeaning;
}

export interface EventLog {
  /** Events after dropping exact duplicates, in file order. */
  events: MeterEvent[];
  /** Exact duplicate rows dropped (same meter, timestamp, event and phase). */
  duplicates: number;
  /** Whether the timestamps carry a zone (Z / +08:00). */
  zoned: boolean;
  hasPhase: boolean;
}

export interface EventColumns {
  meterColumn?: string;
  timeColumn?: string;
  eventColumn?: string;
  phaseColumn?: string;
}

/** Vendor event codes / texts (normalised) -> meaning, from a --map file. */
export type EventMap = Map<string, EventMeaning>;

interface Table {
  rows: { cells: string[]; row: number }[];
  index: (name: string, required: boolean, label: string) => number;
}

function table(text: string, what: string): Table {
  const records = parseCsv(text);
  if (records.length === 0) throw new InputError(`${what}: the file is empty.`);
  const header = records[0].map((h) => h.trim().toLowerCase());
  const rows = records.slice(1).map((cells, i) => ({ cells: cells.map((c) => c.trim()), row: i + 2 }));
  const index = (name: string, required: boolean, label: string) => {
    const i = header.indexOf(name.trim().toLowerCase());
    if (i < 0 && required) {
      throw new InputError(`${what}: no "${name}" column (${label}). Header: ${records[0].join(',')}`);
    }
    return i;
  };
  return { rows, index };
}

function cell(cells: string[], i: number): string {
  return i < 0 ? '' : (cells[i] ?? '');
}

/**
 * Parses a --map file: header `code,event`, one row per vendor code or text. `event` must be a built-in event name
 * or alias. Codes are matched like event names (case, spaces, underscores and hyphens ignored).
 */
export function parseMap(text: string): EventMap {
  const t = table(text, 'map');
  const ci = t.index('code', true, 'vendor event code or text');
  const ei = t.index('event', true, 'built-in event name, e.g. cover-open');
  const map: EventMap = new Map();
  const seen = new Map<string, { event: string; row: number }>();
  for (const { cells, row } of t.rows) {
    const code = cell(cells, ci);
    const event = cell(cells, ei);
    if (!code) throw new InputError(`map row ${row}: empty code.`);
    const meaning = lookupEvent(event);
    if (!meaning) {
      throw new InputError(`map row ${row}: "${event}" is not a known event name (see --list-events).`);
    }
    const key = normaliseEvent(code);
    const prev = seen.get(key);
    if (prev) {
      if (JSON.stringify(map.get(key)) === JSON.stringify(meaning)) continue; // same mapping again
      throw new InputError(`map row ${row}: code "${code}" is already mapped to "${prev.event}" (row ${prev.row}).`);
    }
    seen.set(key, { event, row });
    map.set(key, meaning);
  }
  if (map.size === 0) throw new InputError('map: no rows.');
  return map;
}

/**
 * Parses the event log CSV: `meter,timestamp,event` and an optional `phase` column. Every row needs a meter, a
 * timestamp (one style: all with or all without a zone) and an event. Exact duplicate rows are dropped.
 */
export function parseEvents(text: string, columns: EventColumns = {}, map?: EventMap): EventLog {
  const t = table(text, 'events');
  const mi = t.index(columns.meterColumn ?? 'meter', true, 'meter id / serial');
  const ti = t.index(columns.timeColumn ?? 'timestamp', true, 'event date and time');
  const ei = t.index(columns.eventColumn ?? 'event', true, 'event name or code');
  const pi = t.index(columns.phaseColumn ?? 'phase', columns.phaseColumn !== undefined, 'phase (L1 / L2 / L3)');
  const events: MeterEvent[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let zonedFirst: { zoned: boolean; row: number } | undefined;
  for (const { cells, row } of t.rows) {
    const meter = cell(cells, mi);
    const stamp = cell(cells, ti);
    const event = cell(cells, ei);
    const phase = cell(cells, pi);
    if (!meter) throw new InputError(`events row ${row}: empty meter.`);
    if (!stamp) throw new InputError(`events row ${row}: empty timestamp.`);
    if (!event) throw new InputError(`events row ${row}: empty event.`);
    const parsed = parseStamp(stamp);
    if (!parsed) {
      throw new InputError(`events row ${row}: timestamp "${stamp}" is not a date and time like 2026-11-10 08:01:00 (optional seconds, T, Z or +08:00).`);
    }
    if (!zonedFirst) zonedFirst = { zoned: parsed.zoned, row };
    else if (zonedFirst.zoned !== parsed.zoned) {
      throw new InputError(
        `events row ${row}: timestamp "${stamp}" ${parsed.zoned ? 'has' : 'has no'} time zone, but row ${zonedFirst.row} ${zonedFirst.zoned ? 'has one' : 'has none'}; use one style.`,
      );
    }
    const key = normaliseEvent(event);
    const dupKey = `${meter}\u0000${parsed.ms}\u0000${key}\u0000${phase.toLowerCase()}`;
    if (seen.has(dupKey)) {
      duplicates++;
      continue;
    }
    seen.add(dupKey);
    const meaning = map?.get(key) ?? lookupEvent(event);
    events.push({ row, meter, stamp, ms: parsed.ms, event, phase, ...(meaning && { meaning }) });
  }
  if (events.length === 0) throw new InputError('events: no rows.');
  return { events, duplicates, zoned: zonedFirst!.zoned, hasPhase: pi >= 0 };
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?: ?(Z|[+-]\d{2}:?\d{2}))?$/i;

/**
 * Parses an ISO-like timestamp `YYYY-MM-DD HH:MM[:SS[.fff]]` (T or space, optional Z / +08:00 / +0800).
 * Returns milliseconds and whether a zone was given, or undefined when it is not a valid date and time.
 */
export function parseStamp(text: string): { ms: number; zoned: boolean } | undefined {
  const m = STAMP.exec(text.trim());
  if (!m) return undefined;
  const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const frac = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return undefined;
  const base = Date.UTC(y, mo - 1, d, h, mi, sec);
  if (new Date(base).getUTCDate() !== d) return undefined; // e.g. 2026-02-30
  let ms = base + Math.floor(frac);
  const zone = m[8];
  if (zone && zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
    if (Number(z[2]) > 14 || Number(z[3]) > 59) return undefined;
    const off = Number(z[2]) * 60 + Number(z[3]);
    ms -= (z[1] === '-' ? -1 : 1) * off * 60_000;
  }
  return { ms, zoned: zone !== undefined };
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

/** Parses a duration like 90s, 30m, 1h30m, 1.5h, 2d (largest unit first, each unit once); undefined if invalid or 0. */
export function parseDuration(text: string): number | undefined {
  const t = text.trim().toLowerCase();
  if (!/^(\d+(\.\d+)?[dhms])+$/.test(t)) return undefined;
  let ms = 0;
  const seen = new Set<string>();
  let lastRank = -1;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)([dhms])/g)) {
    const rank = 'dhms'.indexOf(m[2]);
    if (seen.has(m[2]) || rank < lastRank) return undefined;
    seen.add(m[2]);
    lastRank = rank;
    ms += Number(m[1]) * UNIT_MS[m[2]];
  }
  ms = Math.round(ms);
  return ms > 0 ? ms : undefined;
}

/** Formats milliseconds as e.g. 45s, 1m30s, 2h05m, 1d03h00m (largest unit first; seconds left out when zero). */
export function formatDuration(ms: number): string {
  if (ms < 0) return `-${formatDuration(-ms)}`;
  const whole = Math.floor(ms / 1000);
  const sec = Number(((whole % 60) + (ms - whole * 1000) / 1000).toFixed(3));
  const d = Math.floor(whole / 86_400);
  const h = Math.floor((whole % 86_400) / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const two = (v: number) => (v < 10 ? `0${v}` : String(v));
  const tail = sec ? `${two(sec)}s` : '';
  if (d) return `${d}d${two(h)}h${two(m)}m${tail}`;
  if (h) return `${h}h${two(m)}m${tail}`;
  if (m) return `${m}m${tail}`;
  return `${sec}s`;
}

/**
 * Parses --max-per-day values: each value one or more comma-separated `condition=N` (condition names as in the
 * report, e.g. magnetic, cover, terminal-cover, power; matched like event names; N a whole number from 0). A
 * condition given twice is an error.
 */
export function parseMaxPerDay(values: readonly string[]): Partial<Record<Condition, number>> {
  const out: Partial<Record<Condition, number>> = {};
  for (const value of values) {
    for (const item of value.split(',')) {
      const m = /^\s*([^=]*?)\s*=\s*(\S*)\s*$/.exec(item);
      if (!m || !m[1]) throw new InputError(`--max-per-day "${item.trim()}" is not condition=N, e.g. magnetic=3.`);
      const c = normaliseEvent(m[1]) as Condition;
      if (!CONDITIONS.includes(c)) throw new InputError(`--max-per-day: "${m[1]}" is not a condition (${CONDITIONS.join(', ')}).`);
      if (!/^\d+$/.test(m[2]) || Number(m[2]) > 1_000_000) {
        throw new InputError(`--max-per-day: ${c} limit "${m[2]}" must be a whole number from 0 to 1000000.`);
      }
      if (out[c] !== undefined) throw new InputError(`--max-per-day: ${c} is given more than once.`);
      out[c] = Number(m[2]);
    }
  }
  return out;
}
