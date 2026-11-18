import { describe, expect, it } from 'vitest';
import { type CheckOptions, check } from '../src/check.js';
import { parseEvents } from '../src/input.js';

/** Lines "meter time event [phase]" with time as HH:MM on 2026-11-10 or a full stamp with T. */
function run(lines: string[], options: CheckOptions = {}) {
  const rows = lines.map((l) => {
    const [meter, time, event, phase = ''] = l.split(/\s+/);
    const stamp = time.includes('T') ? time.replace('T', ' ') : `2026-11-10 ${time}`;
    return `${meter},${stamp},${event},${phase}`;
  });
  return check(parseEvents(['meter,timestamp,event,phase', ...rows].join('\n')), options);
}

const kinds = (r: ReturnType<typeof check>) => r.findings.map((f) => `${f.kind} ${f.meter}${f.condition ? ` ${f.condition}` : ''}`);

describe('episodes', () => {
  it('pairs start and end; tamper finding with duration and rows', () => {
    const r = run(['M1 08:00 cover-open', 'M1 08:15 cover-close']);
    expect(r.findings).toEqual([
      {
        kind: 'tamper',
        meter: 'M1',
        condition: 'cover',
        phase: '',
        start: '2026-11-10 08:00',
        end: '2026-11-10 08:15',
        durationMs: 15 * 60_000,
        rows: [2, 3],
        message: 'M1 cover open from 2026-11-10 08:00 (row 2) to 2026-11-10 08:15 (row 3), 15m',
      },
    ]);
    const c = r.conditions.find((x) => x.condition === 'cover')!;
    expect(c).toEqual({ condition: 'cover', tamper: true, episodes: 1, ongoing: 0, meters: 1, totalMs: 900_000, longestMs: 900_000 });
  });
  it('replays each meter by time, not file order', () => {
    const r = run(['M1 08:15 cover-close', 'M1 08:00 cover-open']);
    expect(kinds(r)).toEqual(['tamper M1 cover']);
    expect(r.findings[0].rows).toEqual([3, 2]);
  });
  it('equal timestamps keep file order', () => {
    const r = run(['M1 08:00 cover-open', 'M1 08:00 cover-close']);
    expect(r.findings[0].durationMs).toBe(0);
    const r2 = run(['M1 08:00 cover-close', 'M1 08:00 cover-open']);
    expect(kinds(r2)).toEqual(['tamper M1 cover', 'unmatched-end M1 cover']);
    expect(r2.findings[0].end).toBeNull();
  });
  it('every tamper condition is a finding; power and phase loss are not', () => {
    const r = run([
      'M1 01:00 terminal-cover-open',
      'M1 01:10 terminal-cover-close',
      'M1 02:00 magnetic-start',
      'M1 02:01 magnetic-end',
      'M1 03:00 reverse-energy L1',
      'M1 03:30 reverse-energy-end L1',
      'M1 04:00 missing-neutral',
      'M1 04:05 neutral-restored',
      'M1 05:00 bypass',
      'M1 05:20 bypass-end',
      'M1 06:00 power-fail',
      'M1 06:30 power-restore',
      'M1 07:00 phase-loss L3',
      'M1 07:30 phase-restore L3',
    ]);
    expect(kinds(r)).toEqual([
      'tamper M1 terminal-cover',
      'tamper M1 magnetic',
      'tamper M1 reverse',
      'tamper M1 neutral',
      'tamper M1 bypass',
    ]);
    expect(r.findings[2].message).toBe('M1 reverse energy [L1] from 2026-11-10 03:00 (row 6) to 2026-11-10 03:30 (row 7), 30m');
    expect(r.conditions.map((c) => [c.condition, c.episodes])).toEqual([
      ['power', 1],
      ['phase-loss', 1],
      ['cover', 0],
      ['terminal-cover', 1],
      ['magnetic', 1],
      ['reverse', 1],
      ['neutral', 1],
      ['bypass', 1],
    ]);
    expect(r.meters).toEqual([{ meter: 'M1', events: 14, tamperEpisodes: 5, tamperMs: (10 + 1 + 30 + 5 + 20) * 60_000, outages: 1, findings: 5 }]);
  });
  it('phases are separate episodes; an end on another phase is unmatched', () => {
    const r = run(['M1 08:00 phase-loss L1', 'M1 08:05 phase-loss L2', 'M1 08:10 phase-restore L2', 'M1 08:20 phase-restore L3']);
    expect(kinds(r)).toEqual(['unmatched-end M1 phase-loss', 'open-at-end M1 phase-loss']);
    expect(r.findings[0].message).toBe('M1 "phase-restore" [L3] at 2026-11-10 08:20 (row 5) ends a phase loss that never started in the log');
    expect(r.findings[1].phase).toBe('L1');
  });
  it('phase matched case-insensitively', () => {
    const r = run(['M1 08:00 phase-loss l1', 'M1 08:05 phase-restore L1']);
    expect(r.findings).toEqual([]);
    expect(r.conditions[1].totalMs).toBe(300_000);
  });
  it('ongoing tamper at end of log', () => {
    const r = run(['M1 08:00 magnetic-start', 'M1 09:00 power-fail', 'M1 09:30 power-restore']);
    expect(r.findings.map((f) => f.message)).toEqual(['M1 magnetic interference from 2026-11-10 08:00 (row 2), still active at the end of the log']);
    expect(r.findings[0]).toMatchObject({ end: null, durationMs: null, rows: [2] });
    const c = r.conditions.find((x) => x.condition === 'magnetic')!;
    expect(c).toMatchObject({ episodes: 1, ongoing: 1, totalMs: 0, longestMs: null });
  });
  it('open-at-end for power failure and phase loss', () => {
    const r = run(['M1 08:00 power-fail', 'M2 08:00 phase-loss L2']);
    expect(kinds(r)).toEqual(['open-at-end M1 power', 'open-at-end M2 phase-loss']);
    expect(r.findings[0].message).toBe('M1 power failure from 2026-11-10 08:00 (row 2), still active at the end of the log');
  });
  it('repeated start: one finding per episode, rows listed (max 5 in the message)', () => {
    const lines = ['M1 08:00 magnetic-start'];
    for (let i = 1; i <= 7; i++) lines.push(`M1 08:0${i} magnetic-start`);
    lines.push('M1 09:00 magnetic-end', 'M1 10:00 magnetic-start', 'M1 10:01 magnetic-end');
    const r = run(lines);
    expect(kinds(r)).toEqual(['tamper M1 magnetic', 'tamper M1 magnetic', 'repeated-start M1 magnetic']);
    const f = r.findings[2];
    expect(f.rows).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(f.message).toBe(
      'M1 magnetic interference started again 7 time(s) while already active since 2026-11-10 08:00 (row 2; rows 3, 4, 5, 6, 7, ...)',
    );
  });
  it('log cleared, clock adjusted, unknown events', () => {
    const r = run(['M1 08:00 Event_Log_Cleared', 'M1 08:01 clock-set', 'M2 08:02 Clock_Adjusted', 'M1 08:03 relay-off', 'M2 08:04 RELAY_OFF', 'M2 08:05 fw']);
    expect(kinds(r)).toEqual(['log-cleared M1']);
    expect(r.findings[0].message).toBe('M1 event log cleared at 2026-11-10 08:00 (row 2)');
    expect(r.summary).toMatchObject({ logCleared: 1, clockAdjusted: 2, unknownEvents: 3 });
    expect(r.unknown).toEqual([
      { event: 'relay-off', count: 2, firstRow: 5 },
      { event: 'fw', count: 1, firstRow: 7 },
    ]);
  });
});

describe('outages', () => {
  const area = ['A 08:00 power-fail', 'B 08:01 power-fail', 'C 08:02 power-fail', 'A 09:00 power-restore', 'B 09:00 power-restore', 'C 09:10 power-restore'];
  it('area outage: 3 meters within 2 min of the first failure', () => {
    const r = run([...area, 'D 12:00 power-fail', 'D 12:05 power-restore']);
    expect(r.areaOutages).toEqual([
      { start: '2026-11-10 08:00', row: 2, lastStart: '2026-11-10 08:02', meters: 3, restored: '2026-11-10 09:10' },
    ]);
    expect(r.summary).toMatchObject({ outages: 4, outagesInArea: 3, outagesSingleMeter: 1 });
    expect(r.findings).toEqual([]);
  });
  it('window is anchored at the first failure (no chaining) and inclusive', () => {
    const r = run(['A 08:00 power-fail', 'B 08:02 power-fail', 'C 08:02:01 power-fail', 'D 08:03 power-fail', 'E 08:04 power-fail']);
    expect(r.areaOutages.map((a) => [a.start, a.meters, a.restored])).toEqual([['2026-11-10 08:02:01', 3, null]]);
    expect(r.summary.outagesInArea).toBe(3);
  });
  it('the same meter twice in a group counts once', () => {
    const r = run(['A 08:00 power-fail', 'A 08:00:30 power-restore', 'A 08:01 power-fail', 'A 08:01:30 power-restore', 'B 08:01 power-fail', 'B 08:05 power-restore']);
    expect(r.areaOutages).toEqual([]);
    expect(r.summary.outagesSingleMeter).toBe(3);
  });
  it('--outage-window and --area-min', () => {
    const r = run(area, { areaMin: 4 });
    expect(r.areaOutages).toEqual([]);
    const r2 = run(['A 08:00 power-fail', 'B 08:10 power-fail'], { areaMin: 2, outageWindowMs: 600_000 });
    expect(r2.areaOutages).toHaveLength(1);
    expect(() => run(area, { areaMin: 1 })).toThrow(/at least 2/);
  });
  it('--max-outage flags closed outages strictly longer than the limit', () => {
    const r = run(area, { maxOutageMs: 3_480_000 }); // 58m: A 60m, B 59m, C 68m
    expect(kinds(r)).toEqual(['long-outage A power', 'long-outage B power', 'long-outage C power']);
    expect(r.findings[0].message).toBe('A power failure from 2026-11-10 08:00 (row 2) to 2026-11-10 09:00 (row 5), 1h00m (over 58m)');
    expect(kinds(run(area, { maxOutageMs: 3_600_000 }))).toEqual(['long-outage C power']);
    expect(kinds(run(['A 08:00 power-fail'], { maxOutageMs: 1000 }))).toEqual(['open-at-end A power']);
  });
  it('--isolated flags single-meter outages, needs enough meters', () => {
    const r = run([...area, 'D 12:00 power-fail', 'D 12:05 power-restore'], { isolated: true });
    expect(kinds(r)).toEqual(['isolated-outage D power']);
    expect(r.findings[0].message).toBe('D power failure from 2026-11-10 12:00 (row 8) to 2026-11-10 12:05 (row 9), 5m: fewer than 3 meters failed within 2m');
    expect(() => run(['A 08:00 power-fail', 'B 08:00 power-fail'], { isolated: true })).toThrow(/needs at least --area-min \(3\) meters .* has 2/);
  });
});

describe('tamper near outage', () => {
  const outage = ['M1 10:00 power-fail', 'M1 11:00 power-restore'];
  const near = (time: string, options: CheckOptions = {}) =>
    run([...outage, `M1 ${time} cover-open`, `M1 ${time.replace(/^(\d\d)/, (h) => String(Number(h) + 5).padStart(2, '0'))} cover-close`], options).findings.filter(
      (f) => f.kind === 'tamper-near-outage',
    );
  it('during, before and after within --near (inclusive)', () => {
    expect(near('10:30')[0].message).toBe(
      'M1 cover open at 2026-11-10 10:30 (row 4) during the power failure from 2026-11-10 10:00 (row 2) to 2026-11-10 11:00 (row 3), 1h00m',
    );
    expect(near('10:30')[0].rows).toEqual([4, 2, 3]);
    expect(near('09:55')[0].message).toContain('before the power failure');
    expect(near('11:05')[0].message).toContain('after the power failure');
    expect(near('09:54')).toEqual([]);
    expect(near('11:05:01')).toEqual([]);
    expect(near('11:20', { nearMs: 20 * 60_000 })).toHaveLength(1);
  });
  it('terminal cover counts, magnetic does not, other meters do not', () => {
    const r = run([...outage, 'M1 10:10 terminal-cover-open', 'M1 10:12 magnetic-start', 'M2 10:20 cover-open']);
    expect(kinds(r).filter((k) => k.startsWith('tamper-near'))).toEqual(['tamper-near-outage M1 terminal-cover']);
  });
  it('an outage still open covers everything after its start', () => {
    const r = run(['M1 10:00 power-fail', 'M1T2026-11-12T10:00 cover-open'.replace('M1T', 'M1 ')]);
    expect(r.findings.find((f) => f.kind === 'tamper-near-outage')!.message).toBe(
      'M1 cover open at 2026-11-12 10:00 (row 3) during the power failure from 2026-11-10 10:00 (row 2), still active at the end of the log',
    );
  });
});

describe('report', () => {
  it('findings ordered by kind, then meter first appearance, then row; counts and meter ranking', () => {
    const r = run(['B 08:00 cover-open', 'A 08:00 log-cleared', 'A 08:05 magnetic-start', 'A 08:06 magnetic-end', 'A 08:07 cover-open', 'B 08:30 cover-close', 'C 09:00 power-restore']);
    expect(kinds(r)).toEqual(['tamper B cover', 'tamper A magnetic', 'tamper A cover', 'log-cleared A', 'unmatched-end C power']);
    expect(r.counts).toEqual({ tamper: 3, 'log-cleared': 1, 'unmatched-end': 1 });
    expect(r.meters.map((m) => [m.meter, m.tamperEpisodes, m.findings])).toEqual([
      ['A', 2, 3],
      ['B', 1, 1],
      ['C', 0, 1],
    ]);
    expect(r.summary).toMatchObject({ meters: 3, events: 7, from: '2026-11-10 08:00', to: '2026-11-10 09:00', duplicatesDropped: 0 });
    expect(r.settings).toEqual({ nearMs: 300_000, outageWindowMs: 120_000, areaMin: 3, maxOutageMs: null, isolated: false });
  });
  it('meters without tamper or findings are not listed', () => {
    const r = run(['A 08:00 power-fail', 'A 08:10 power-restore']);
    expect(r.meters).toEqual([]);
    expect(r.findings).toEqual([]);
  });
});
