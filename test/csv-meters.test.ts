import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { check } from '../src/check.js';
import { main } from '../src/cli.js';
import { CSV_METER_HEADER, csvMeterHeader, csvMetersReport } from '../src/formats.js';
import { parseEvents, parseMap, parseMaxPerDay } from '../src/input.js';
import { ex } from './helpers.js';

const HEADER =
  'meter,events,tamper_episodes,tamper_time,tamper_ms,outages,findings,cover,terminal-cover,magnetic,reverse,neutral,bypass,' +
  'tamper-near-outage,log-cleared,unmatched-end,repeated-start,open-at-end,long-outage,isolated-outage,frequency-exceeded';

const report = (rows: string[], options = {}) => check(parseEvents(['meter,timestamp,event,phase', ...rows].join('\n')), options);
const lines = (text: string) => text.trimEnd().split('\n');

function run(args: string[]) {
  let out = '';
  let err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  try {
    return { code: main(args), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

function tmp(name: string, text: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'mec-')), name);
  writeFileSync(p, text);
  return p;
}

describe('csvMetersReport', () => {
  it('header lists the fixed columns, the tamper conditions, then every finding kind except tamper', () => {
    expect(csvMeterHeader().join(',')).toBe(HEADER);
    expect(CSV_METER_HEADER).toEqual(['meter', 'events', 'tamper_episodes', 'tamper_time', 'tamper_ms', 'outages', 'findings']);
  });

  it('header only when no meter has tamper or findings', () => {
    const r = report(['M1,2026-11-10 08:00,power-fail,', 'M1,2026-11-10 08:30,power-restore,']);
    expect(csvMetersReport(r)).toBe(`${HEADER}\n`);
  });

  it('counts tamper episodes per condition and findings per kind; most tamper first', () => {
    const r = report([
      'M1,2026-11-10 08:00,log-cleared,',
      'M2,2026-11-10 08:00,magnetic-start,',
      'M2,2026-11-10 08:10,magnetic-end,',
      'M2,2026-11-10 09:00,cover-open,',
      'M2,2026-11-10 09:05,cover-close,',
      'M2,2026-11-10 10:00,reverse-start,L1',
      'M2,2026-11-10 10:05,reverse-start,L1',
      'M3,2026-11-10 11:00,power-restore,',
    ]);
    expect(lines(csvMetersReport(r))).toEqual([
      HEADER,
      // 3 tamper episodes (1 still active), 15m closed; tamper 3 + repeated-start 1 = 4 findings.
      'M2,6,3,15m,900000,0,4,1,0,1,1,0,0,0,0,0,1,0,0,0,0',
      'M1,1,0,,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0',
      'M3,1,0,,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0',
    ]);
  });

  it('opt-in findings get their columns (long-outage, isolated-outage, frequency-exceeded, open-at-end)', () => {
    const r = report(
      [
        'M1,2026-11-10 08:00,power-fail,',
        'M1,2026-11-10 11:00,power-restore,',
        'M1,2026-11-10 12:00,power-fail,',
        'M2,2026-11-10 08:00,cover-open,',
        'M2,2026-11-10 08:10,cover-close,',
        'M3,2026-11-10 08:00,clock-adjusted,',
      ],
      { maxOutageMs: 3_600_000, isolated: true, areaMin: 2, maxPerDay: { power: 1 } },
    );
    expect(lines(csvMetersReport(r))).toEqual([
      HEADER,
      'M2,2,1,10m,600000,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0',
      // open-at-end 1, long-outage 1, isolated-outage 2, frequency-exceeded 1 = 5
      'M1,3,0,,0,2,5,0,0,0,0,0,0,0,0,0,0,1,1,2,1',
    ]);
  });

  it('findings column equals tamper_episodes plus the per-kind columns, and tamper_episodes the per-condition sum', () => {
    const cases = [
      check(parseEvents(readFileSync(ex('events.csv'), 'utf8')), { maxOutageMs: 3_600_000, isolated: true }),
      check(parseEvents(readFileSync(ex('frequency.csv'), 'utf8')), { maxPerDay: parseMaxPerDay(['magnetic=3,cover=1,phase-loss=1']) }),
      check(
        parseEvents(
          readFileSync(ex('vendor-events.csv'), 'utf8'),
          { meterColumn: 'meter_no', timeColumn: 'event_time', eventColumn: 'event_code' },
          parseMap(readFileSync(ex('vendor-map.csv'), 'utf8')),
        ),
      ),
    ];
    for (const r of cases) {
      const rows = lines(csvMetersReport(r)).slice(1);
      expect(rows.length).toBe(r.meters.length);
      expect(rows.length).toBeGreaterThan(0);
      let total = 0;
      for (const row of rows) {
        const c = row.split(',');
        const nums = c.slice(7).map(Number);
        expect(nums.slice(0, 6).reduce((a, b) => a + b, 0)).toBe(Number(c[2]));
        expect(Number(c[2]) + nums.slice(6).reduce((a, b) => a + b, 0)).toBe(Number(c[6]));
        total += Number(c[6]);
      }
      expect(total).toBe(r.findings.length);
    }
  });

  it('guards meter ids that look like formulas and quotes commas', () => {
    const r = check(parseEvents('meter,timestamp,event\n"=HYPERLINK(""x"",1)",2026-11-10 08:00,log-cleared\n"-M,2",2026-11-10 08:00,log-cleared\n'));
    const out = lines(csvMetersReport(r));
    expect(out[1].startsWith('"\'=HYPERLINK(""x"",1)",1,0,,0,0,1,')).toBe(true);
    expect(out[2].startsWith('"\'-M,2",1,0,,0,0,1,')).toBe(true);
  });
});

describe('cli --csv-meters', () => {
  it('example log: one row per flagged meter, exit 1', () => {
    const r = run([ex('events.csv'), '--csv-meters']);
    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    expect(r.out).toBe(
      [
        HEADER,
        'MTR-0002,4,1,15m,900000,1,2,1,0,0,0,0,0,1,0,0,0,0,0,0,0',
        'MTR-0003,5,1,1h30m,5400000,1,2,0,0,1,0,0,0,0,0,0,1,0,0,0,0',
        'MTR-0004,6,1,43m,2580000,2,2,0,1,0,0,0,0,1,0,0,0,0,0,0,0',
        'MTR-0006,6,1,0s,0,1,2,0,0,0,1,0,0,0,0,0,0,1,0,0,0',
        'MTR-0005,4,0,,0,1,2,0,0,0,0,0,0,0,1,1,0,0,0,0,0',
        '',
      ].join('\n'),
    );
  });

  it('ignores --limit (every meter listed)', () => {
    const r = run([ex('events.csv'), '--csv-meters', '--limit', '1']);
    expect(lines(r.out)).toHaveLength(6);
  });

  it('clean log: header only, exit 0', () => {
    const p = tmp('e.csv', 'meter,timestamp,event\nM1,2026-11-10 08:00,power-fail\nM1,2026-11-10 08:30,power-restore\n');
    const r = run([p, '--csv-meters']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${HEADER}\n`);
  });

  it.each([['--json'], ['--md'], ['--csv']])('--csv-meters with %s is an input error (exit 2)', (other) => {
    const r = run([ex('events.csv'), '--csv-meters', other]);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toBe('meter-event-check: pick one of --json, --md, --csv, --csv-meters.\n');
  });

  it('--help documents it', () => {
    expect(run(['--help']).out).toContain('--csv-meters             CSV, one row per meter with tamper or findings');
  });
});
