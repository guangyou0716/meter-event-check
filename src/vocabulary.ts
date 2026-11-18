/** A condition that a meter enters (start event) and leaves (end event). */
export type Condition = 'power' | 'phase-loss' | 'cover' | 'terminal-cover' | 'magnetic' | 'reverse' | 'neutral' | 'bypass';

/** Conditions that count as tamper (each episode is a `tamper` finding). */
export const TAMPER_CONDITIONS: readonly Condition[] = ['cover', 'terminal-cover', 'magnetic', 'reverse', 'neutral', 'bypass'];

/** Every condition in report order. */
export const CONDITIONS: readonly Condition[] = ['power', 'phase-loss', ...TAMPER_CONDITIONS];

/** Events without a duration. */
export type SingleEvent = 'log-cleared' | 'clock-adjusted';

/** What a canonical event name means. */
export type EventMeaning =
  | { kind: 'start'; condition: Condition }
  | { kind: 'end'; condition: Condition }
  | { kind: 'single'; event: SingleEvent };

interface Entry {
  meaning: EventMeaning;
  /** Canonical name first, then aliases. */
  names: string[];
}

const start = (condition: Condition, ...names: string[]): Entry => ({ meaning: { kind: 'start', condition }, names });
const end = (condition: Condition, ...names: string[]): Entry => ({ meaning: { kind: 'end', condition }, names });
const single = (event: SingleEvent, ...names: string[]): Entry => ({ meaning: { kind: 'single', event }, names });

/**
 * Built-in event names (canonical name first, then aliases). Vendor logs differ, so names are matched after
 * normalising (see normaliseEvent) and a --map file can translate vendor codes or texts to these names.
 */
export const VOCABULARY: readonly Entry[] = [
  start('power', 'power-fail', 'power-failure', 'power-off', 'power-down', 'outage-start', 'power-fail-start'),
  end('power', 'power-restore', 'power-restored', 'power-on', 'power-up', 'outage-end', 'power-fail-end'),
  start('phase-loss', 'phase-loss', 'phase-loss-start', 'phase-failure', 'voltage-missing', 'voltage-loss'),
  end('phase-loss', 'phase-restore', 'phase-restored', 'phase-loss-end', 'voltage-restored', 'voltage-missing-end'),
  start('cover', 'cover-open', 'cover-opened', 'cover-removed', 'meter-cover-open', 'meter-cover-opened', 'meter-cover-removed', 'cover-open-start'),
  end('cover', 'cover-close', 'cover-closed', 'meter-cover-close', 'meter-cover-closed', 'cover-open-end'),
  start('terminal-cover', 'terminal-cover-open', 'terminal-cover-opened', 'terminal-cover-removed', 'terminal-cover-open-start'),
  end('terminal-cover', 'terminal-cover-close', 'terminal-cover-closed', 'terminal-cover-open-end'),
  start('magnetic', 'magnetic-start', 'magnetic-tamper', 'magnetic-tamper-start', 'magnetic-interference', 'magnetic-interference-start', 'magnet-detected'),
  end('magnetic', 'magnetic-end', 'magnetic-tamper-end', 'magnetic-interference-end', 'magnet-removed'),
  start('reverse', 'reverse-start', 'reverse-energy', 'reverse-energy-start', 'reverse-current', 'reverse-current-start'),
  end('reverse', 'reverse-end', 'reverse-energy-end', 'reverse-current-end'),
  start('neutral', 'neutral-missing', 'missing-neutral', 'neutral-missing-start', 'neutral-disturbance', 'neutral-disturbance-start'),
  end('neutral', 'neutral-restore', 'neutral-restored', 'neutral-missing-end', 'neutral-disturbance-end'),
  start('bypass', 'bypass-start', 'bypass', 'meter-bypass', 'bypass-detected'),
  end('bypass', 'bypass-end', 'meter-bypass-end'),
  single('log-cleared', 'log-cleared', 'event-log-cleared', 'events-cleared'),
  single('clock-adjusted', 'clock-adjusted', 'clock-adjust', 'clock-set', 'time-adjusted', 'time-set', 'before-clock-adjusted', 'after-clock-adjusted'),
];

/** Lower case; runs of spaces, underscores, dots and hyphens become one hyphen; trimmed. "Cover_Open" -> "cover-open". */
export function normaliseEvent(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const LOOKUP = new Map<string, EventMeaning>();
for (const e of VOCABULARY) for (const n of e.names) LOOKUP.set(n, e.meaning);

/** The meaning of an event name (normalised first), or undefined when it is not in the vocabulary. */
export function lookupEvent(name: string): EventMeaning | undefined {
  return LOOKUP.get(normaliseEvent(name));
}

/** Canonical event name of a meaning (for messages). */
export function canonicalName(m: EventMeaning): string {
  const e = VOCABULARY.find((v) => JSON.stringify(v.meaning) === JSON.stringify(m));
  return e!.names[0];
}

export function isTamper(c: Condition): boolean {
  return TAMPER_CONDITIONS.includes(c);
}
