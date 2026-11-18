import { InputError } from './errors.js';
import { type EventLog, type MeterEvent, formatDuration } from './input.js';
import { CONDITIONS, type Condition, isTamper, normaliseEvent } from './vocabulary.js';

export type FindingKind =
  | 'tamper'
  | 'tamper-near-outage'
  | 'log-cleared'
  | 'unmatched-end'
  | 'repeated-start'
  | 'open-at-end'
  | 'long-outage'
  | 'isolated-outage';

/** Report order of finding kinds. */
export const FINDING_KINDS: readonly FindingKind[] = [
  'tamper',
  'tamper-near-outage',
  'log-cleared',
  'unmatched-end',
  'repeated-start',
  'open-at-end',
  'long-outage',
  'isolated-outage',
];

export interface Finding {
  kind: FindingKind;
  meter: string;
  condition?: Condition;
  /** Phase as written ('' = none). */
  phase?: string;
  /** Start / end timestamps as written (end null = still active at the end of the meter's log). */
  start?: string;
  end?: string | null;
  durationMs?: number | null;
  /** File rows involved. */
  rows: number[];
  message: string;
}

/** A start..end span of one condition at one meter (and phase). */
export interface Episode {
  meter: string;
  condition: Condition;
  phase: string;
  start: MeterEvent;
  /** undefined = still active at the end of the meter's log. */
  end?: MeterEvent;
  /** Rows of further start events while the episode was already active. */
  repeats: number[];
}

export interface CheckOptions {
  /** Cover opened within this many ms before an outage or after its restore counts as near (default 5 min). */
  nearMs?: number;
  /** Power failures within this many ms of a cluster's first failure form one cluster (default 2 min). */
  outageWindowMs?: number;
  /** Distinct meters a cluster needs to be an area outage (default 3). */
  areaMin?: number;
  /** Flag outages longer than this (opt-in). */
  maxOutageMs?: number;
  /** Flag single-meter outages (opt-in). */
  isolated?: boolean;
}

export interface ConditionStat {
  condition: Condition;
  tamper: boolean;
  episodes: number;
  /** Episodes still active at the end of their meter's log. */
  ongoing: number;
  meters: number;
  /** Sum and longest duration of closed episodes in ms (null when none closed). */
  totalMs: number;
  longestMs: number | null;
}

export interface AreaOutage {
  /** Timestamp (as written) and row of the cluster's first power failure. */
  start: string;
  row: number;
  /** Timestamp of the cluster's last power failure. */
  lastStart: string;
  meters: number;
  /** Latest restore among the cluster's outages (null if any is still open). */
  restored: string | null;
}

export interface MeterStat {
  meter: string;
  events: number;
  tamperEpisodes: number;
  /** Closed tamper time in ms. */
  tamperMs: number;
  outages: number;
  findings: number;
}

export interface Report {
  summary: {
    meters: number;
    events: number;
    duplicatesDropped: number;
    from: string;
    to: string;
    hasPhase: boolean;
    logCleared: number;
    clockAdjusted: number;
    outages: number;
    /** Power failures inside an area outage cluster / the rest. */
    outagesInArea: number;
    outagesSingleMeter: number;
    unknownEvents: number;
  };
  settings: { nearMs: number; outageWindowMs: number; areaMin: number; maxOutageMs: number | null; isolated: boolean };
  conditions: ConditionStat[];
  areaOutages: AreaOutage[];
  /** Meters with tamper episodes or findings, most tamper first. */
  meters: MeterStat[];
  unknown: { event: string; count: number; firstRow: number }[];
  counts: Partial<Record<FindingKind, number>>;
  findings: Finding[];
}

const LABEL: Record<Condition, string> = {
  power: 'power failure',
  'phase-loss': 'phase loss',
  cover: 'cover open',
  'terminal-cover': 'terminal cover open',
  magnetic: 'magnetic interference',
  reverse: 'reverse energy',
  neutral: 'missing neutral',
  bypass: 'bypass',
};

export const conditionLabel = (c: Condition) => LABEL[c];

function span(ep: Episode): string {
  const ph = ep.phase ? ` [${ep.phase}]` : '';
  const head = `${LABEL[ep.condition]}${ph} from ${ep.start.stamp} (row ${ep.start.row})`;
  if (!ep.end) return `${head}, still active at the end of the log`;
  return `${head} to ${ep.end.stamp} (row ${ep.end.row}), ${formatDuration(ep.end.ms - ep.start.ms)}`;
}

/** Time of each finding (ms) for sorting; not part of the report. */
const findingTime = new WeakMap<Finding, number>();

function episodeFinding(kind: FindingKind, ep: Episode, message: string, rows?: number[]): Finding {
  const f: Finding = {
    kind,
    meter: ep.meter,
    condition: ep.condition,
    phase: ep.phase,
    start: ep.start.stamp,
    end: ep.end ? ep.end.stamp : null,
    durationMs: ep.end ? ep.end.ms - ep.start.ms : null,
    rows: rows ?? (ep.end ? [ep.start.row, ep.end.row] : [ep.start.row]),
    message,
  };
  findingTime.set(f, ep.start.ms);
  return f;
}

function eventFinding(f: Finding, e: MeterEvent): Finding {
  findingTime.set(f, e.ms);
  return f;
}

/** Audits an event log: pairs start / end events into episodes, clusters power failures, and lists findings. */
export function check(log: EventLog, options: CheckOptions = {}): Report {
  const nearMs = options.nearMs ?? 5 * 60_000;
  const outageWindowMs = options.outageWindowMs ?? 2 * 60_000;
  const areaMin = options.areaMin ?? 3;
  if (areaMin < 2) throw new InputError('--area-min must be at least 2.');

  // Group by meter (first appearance order) and replay each meter's log by time (stable: equal times keep file order).
  const byMeter = new Map<string, MeterEvent[]>();
  for (const e of log.events) {
    const list = byMeter.get(e.meter);
    if (list) list.push(e);
    else byMeter.set(e.meter, [e]);
  }
  if (options.isolated && byMeter.size < areaMin) {
    throw new InputError(`--isolated needs at least --area-min (${areaMin}) meters in the log to tell area outages apart; the log has ${byMeter.size}.`);
  }

  const findings: Finding[] = [];
  const episodes: Episode[] = [];
  const unknown = new Map<string, { event: string; count: number; firstRow: number }>();
  let logCleared = 0;
  let clockAdjusted = 0;
  let fromMs = Infinity;
  let toMs = -Infinity;
  let from = '';
  let to = '';
  const meterStats = new Map<string, MeterStat>();

  for (const [meter, list] of byMeter) {
    list.sort((a, b) => a.ms - b.ms);
    meterStats.set(meter, { meter, events: list.length, tamperEpisodes: 0, tamperMs: 0, outages: 0, findings: 0 });
    if (list[0].ms < fromMs) {
      fromMs = list[0].ms;
      from = list[0].stamp;
    }
    const last = list[list.length - 1];
    if (last.ms > toMs) {
      toMs = last.ms;
      to = last.stamp;
    }
    const open = new Map<string, Episode>();
    for (const e of list) {
      const m = e.meaning;
      if (!m) {
        const key = normaliseEvent(e.event);
        const u = unknown.get(key);
        if (u) u.count++;
        else unknown.set(key, { event: e.event, count: 1, firstRow: e.row });
        continue;
      }
      if (m.kind === 'single') {
        if (m.event === 'clock-adjusted') clockAdjusted++;
        else {
          logCleared++;
          findings.push(
            eventFinding({ kind: 'log-cleared', meter, start: e.stamp, rows: [e.row], message: `${meter} event log cleared at ${e.stamp} (row ${e.row})` }, e),
          );
        }
        continue;
      }
      const key = `${m.condition}\u0000${e.phase.toLowerCase()}`;
      const ep = open.get(key);
      if (m.kind === 'start') {
        if (ep) ep.repeats.push(e.row);
        else open.set(key, { meter, condition: m.condition, phase: e.phase, start: e, repeats: [] });
      } else if (ep) {
        ep.end = e;
        episodes.push(ep);
        open.delete(key);
      } else {
        const ph = e.phase ? ` [${e.phase}]` : '';
        const message = `${meter} "${e.event}"${ph} at ${e.stamp} (row ${e.row}) ends a ${LABEL[m.condition]} that never started in the log`;
        findings.push(eventFinding({ kind: 'unmatched-end', meter, condition: m.condition, phase: e.phase, start: e.stamp, rows: [e.row], message }, e));
      }
    }
    episodes.push(...open.values());
  }

  // Power failure clusters: anchored at the first failure, a cluster takes failures within the window of it.
  const power = episodes.filter((ep) => ep.condition === 'power').sort((a, b) => a.start.ms - b.start.ms);
  const area = new Set<Episode>();
  const areaOutages: AreaOutage[] = [];
  for (let i = 0; i < power.length; ) {
    let j = i;
    while (j < power.length && power[j].start.ms - power[i].start.ms <= outageWindowMs) j++;
    const members = power.slice(i, j);
    const meters = new Set(members.map((ep) => ep.meter)).size;
    if (meters >= areaMin) {
      for (const ep of members) area.add(ep);
      const restored = members.every((ep) => ep.end) ? members.reduce((a, ep) => (ep.end!.ms > a.end!.ms ? ep : a)).end!.stamp : null;
      areaOutages.push({ start: members[0].start.stamp, row: members[0].start.row, lastStart: members[members.length - 1].start.stamp, meters, restored });
    }
    i = j;
  }

  // Outages per meter (for the near check), in time order.
  const outagesOf = new Map<string, Episode[]>();
  for (const ep of power) {
    const l = outagesOf.get(ep.meter);
    if (l) l.push(ep);
    else outagesOf.set(ep.meter, [ep]);
  }

  for (const ep of episodes) {
    const st = meterStats.get(ep.meter)!;
    if (isTamper(ep.condition)) {
      st.tamperEpisodes++;
      if (ep.end) st.tamperMs += ep.end.ms - ep.start.ms;
      findings.push(episodeFinding('tamper', ep, `${ep.meter} ${span(ep)}`));
      if (ep.condition === 'cover' || ep.condition === 'terminal-cover') {
        const t = ep.start.ms;
        const near = (outagesOf.get(ep.meter) ?? []).find((o) => t >= o.start.ms - nearMs && t <= (o.end ? o.end.ms : Infinity) + nearMs);
        if (near) {
          const where = t < near.start.ms ? 'before' : near.end && t > near.end.ms ? 'after' : 'during';
          findings.push(
            episodeFinding(
              'tamper-near-outage',
              ep,
              `${ep.meter} ${LABEL[ep.condition]} at ${ep.start.stamp} (row ${ep.start.row}) ${where} the ${span(near)}`,
              [ep.start.row, near.start.row, ...(near.end ? [near.end.row] : [])],
            ),
          );
        }
      }
    } else if (!ep.end) {
      findings.push(episodeFinding('open-at-end', ep, `${ep.meter} ${span(ep)}`));
    }
    if (ep.repeats.length) {
      const ph = ep.phase ? ` [${ep.phase}]` : '';
      findings.push(
        episodeFinding(
          'repeated-start',
          ep,
          `${ep.meter} ${LABEL[ep.condition]}${ph} started again ${ep.repeats.length} time(s) while already active since ${ep.start.stamp} (row ${ep.start.row}; rows ${ep.repeats.slice(0, 5).join(', ')}${ep.repeats.length > 5 ? ', ...' : ''})`,
          [ep.start.row, ...ep.repeats],
        ),
      );
    }
    if (ep.condition === 'power') {
      st.outages++;
      if (options.maxOutageMs !== undefined && ep.end && ep.end.ms - ep.start.ms > options.maxOutageMs) {
        findings.push(episodeFinding('long-outage', ep, `${ep.meter} ${span(ep)} (over ${formatDuration(options.maxOutageMs)})`));
      }
      if (options.isolated && !area.has(ep)) {
        findings.push(episodeFinding('isolated-outage', ep, `${ep.meter} ${span(ep)}: fewer than ${areaMin} meters failed within ${formatDuration(outageWindowMs)}`));
      }
    }
  }

  // Order: kind, then meter (first appearance), then time (stable: equal times keep the order found).
  const meterOrder = new Map([...byMeter.keys()].map((m, i) => [m, i]));
  const kindOrder = new Map(FINDING_KINDS.map((k, i) => [k, i]));
  findings.sort(
    (a, b) => kindOrder.get(a.kind)! - kindOrder.get(b.kind)! || meterOrder.get(a.meter)! - meterOrder.get(b.meter)! || findingTime.get(a)! - findingTime.get(b)!,
  );
  const counts: Partial<Record<FindingKind, number>> = {};
  for (const f of findings) {
    counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    meterStats.get(f.meter)!.findings++;
  }

  const conditions: ConditionStat[] = CONDITIONS.map((condition) => {
    const eps = episodes.filter((ep) => ep.condition === condition);
    const closed = eps.filter((ep) => ep.end).map((ep) => ep.end!.ms - ep.start.ms);
    return {
      condition,
      tamper: isTamper(condition),
      episodes: eps.length,
      ongoing: eps.length - closed.length,
      meters: new Set(eps.map((ep) => ep.meter)).size,
      totalMs: closed.reduce((a, b) => a + b, 0),
      longestMs: closed.length ? closed.reduce((a, b) => (b > a ? b : a)) : null,
    };
  });

  const meters = [...meterStats.values()]
    .filter((s) => s.tamperEpisodes > 0 || s.findings > 0)
    .sort((a, b) => b.tamperEpisodes - a.tamperEpisodes || b.findings - a.findings || meterOrder.get(a.meter)! - meterOrder.get(b.meter)!);

  return {
    summary: {
      meters: byMeter.size,
      events: log.events.length,
      duplicatesDropped: log.duplicates,
      from,
      to,
      hasPhase: log.hasPhase,
      logCleared,
      clockAdjusted,
      outages: power.length,
      outagesInArea: area.size,
      outagesSingleMeter: power.length - area.size,
      unknownEvents: [...unknown.values()].reduce((a, u) => a + u.count, 0),
    },
    settings: { nearMs, outageWindowMs, areaMin, maxOutageMs: options.maxOutageMs ?? null, isolated: options.isolated === true },
    conditions,
    areaOutages,
    meters,
    unknown: [...unknown.values()].sort((a, b) => b.count - a.count || a.firstRow - b.firstRow),
    counts,
    findings,
  };
}
