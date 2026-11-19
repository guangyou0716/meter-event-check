import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CheckOptions, check } from '../src/check.js';
import { main } from '../src/cli.js';
import { CSV_FREQUENCY_COLUMNS, CSV_HEADER, csvReport, mdReport } from '../src/formats.js';
import { parseEvents, parseMaxPerDay } from '../src/input.js';
import { jsonReport, textReport } from '../src/report.js';
import { ex } from './helpers.js';

const log = (rows: string[]) => parseEvents(['meter,timestamp,event,phase', ...rows].join('\n'));
const report = (rows: string[], options: CheckOptions = {}) => check(log(rows), options);
const freq = (r: ReturnType<typeof check>) => r.findings.filter((f) => f.kind === 'frequency-exceeded');

/** n closed episodes of `cond` (start / end event names) at meter m on day, hourly from 01:00. */
function episodes(m: string, day: string, n: number, start = 'magnetic-start', end = 'magnetic-end', phase = ''): string[] {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = String(i + 1).padStart(2, '0');
    rows.push(`${m},${day} ${h}:00,${start},${phase}`, `${m},${day} ${h}:05,${end},${phase}`);
  }
  return rows;
}

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

describe('parseMaxPerDay', () => {
  it('parses repeated values and comma lists, normalising condition names', () => {
    expect(parseMaxPerDay(['magnetic=3', 'Cover = 1, terminal_cover=0', 'PHASE LOSS=2'])).toEqual({
      magnetic: 3,
      cover: 1,
      'terminal-cover': 0,
      'phase-loss': 2,
    });
    expect(parseMaxPerDay([])).toEqual({});
  });

  it.each([
    ['foo=1', /"foo" is not a condition/],
    ['log-cleared=1', /is not a condition/],
    ['magnetic', /is not condition=N/],
    ['=3', /is not condition=N/],
    ['magnetic=', /must be a whole number/],
    ['magnetic=x', /must be a whole number/],
    ['magnetic=-1', /must be a whole number/],
    ['magnetic=1.5', /must be a whole number/],
    ['magnetic=1000001', /must be a whole number/],
    ['magnetic=1,', /is not condition=N/],
    ['magnetic=1,magnetic=2', /given more than once/],
  ])('%s is rejected', (v, msg) => {
    expect(() => parseMaxPerDay([v])).toThrow(msg);
  });

  it('a condition repeated across flags is rejected', () => {
    expect(() => parseMaxPerDay(['cover=1', 'cover=2'])).toThrow(/cover is given more than once/);
  });
});

describe('frequency-exceeded', () => {
  it('exactly N starts on a day is not flagged; N + 1 is', () => {
    expect(freq(report(episodes('M1', '2026-11-10', 3), { maxPerDay: { magnetic: 3 } }))).toEqual([]);
    const r = report(episodes('M1', '2026-11-10', 4), { maxPerDay: { magnetic: 3 } });
    expect(freq(r)).toEqual([
      {
        kind: 'frequency-exceeded',
        meter: 'M1',
        condition: 'magnetic',
        start: '2026-11-10 01:00',
        rows: [2, 4, 6, 8],
        day: '2026-11-10',
        count: 4,
        limit: 3,
        message: 'M1 magnetic interference started 4 times on 2026-11-10, over the limit of 3 per day (rows 2, 4, 6, 8)',
      },
    ]);
    expect(r.counts['frequency-exceeded']).toBe(1);
    expect(r.meters.find((m) => m.meter === 'M1')!.findings).toBe(4 + 1);
  });

  it('counts per calendar day of the start (an episode over midnight counts on its start day)', () => {
    const rows = [
      ...episodes('M1', '2026-11-10', 2),
      'M1,2026-11-10 23:50,magnetic-start,',
      'M1,2026-11-11 00:20,magnetic-end,',
      ...episodes('M1', '2026-11-11', 2),
    ];
    const r = report(rows, { maxPerDay: { magnetic: 2 } });
    expect(freq(r).map((f) => [f.day, f.count])).toEqual([['2026-11-10', 3]]);
    expect(freq(report(rows, { maxPerDay: { magnetic: 3 } }))).toEqual([]);
  });

  it('a start while already active is part of its episode, not a new start', () => {
    const rows = ['M1,2026-11-10 01:00,magnetic-start,', 'M1,2026-11-10 01:01,magnetic-start,', 'M1,2026-11-10 01:02,magnetic-start,', 'M1,2026-11-10 02:00,magnetic-end,'];
    expect(freq(report(rows, { maxPerDay: { magnetic: 1 } }))).toEqual([]);
    expect(freq(report(rows, { maxPerDay: { magnetic: 0 } })).map((f) => f.message)).toEqual([
      'M1 magnetic interference started 1 time on 2026-11-10, over the limit of 0 per day (rows 2)',
    ]);
  });

  it('counts ongoing episodes and every phase of a condition together', () => {
    const rows = [...episodes('M1', '2026-11-10', 1, 'phase-loss', 'phase-restore', 'L1'), 'M1,2026-11-10 09:00,phase-loss,L2'];
    const f = freq(report(rows, { maxPerDay: { 'phase-loss': 1 } }));
    expect(f.map((x) => [x.condition, x.count, x.rows, x.phase])).toEqual([['phase-loss', 2, [2, 4], undefined]]);
  });

  it('per meter; multiple conditions; only limited conditions counted; ordered by meter then time', () => {
    const rows = [
      ...episodes('M2', '2026-11-10', 2, 'cover-open', 'cover-close'),
      ...episodes('M1', '2026-11-11', 2),
      ...episodes('M1', '2026-11-10', 2, 'cover-open', 'cover-close'),
      ...episodes('M2', '2026-11-10', 5, 'reverse-start', 'reverse-end'),
      ...episodes('M3', '2026-11-10', 1, 'cover-open', 'cover-close'),
    ];
    const r = report(rows, { maxPerDay: { magnetic: 1, cover: 1 } });
    expect(freq(r).map((f) => `${f.meter} ${f.condition} ${f.day} ${f.count}`)).toEqual([
      'M2 cover 2026-11-10 2',
      'M1 cover 2026-11-10 2',
      'M1 magnetic 2026-11-11 2',
    ]);
    expect(r.settings.maxPerDay).toEqual({ cover: 1, magnetic: 1 });
  });

  it('uses the date as written in zoned timestamps (its own offset)', () => {
    const rows = [
      'M1,2026-11-10 23:30:00+08:00,cover-open,',
      'M1,2026-11-10 23:31:00+08:00,cover-close,',
      'M1,2026-11-11 00:30:00+08:00,cover-open,',
      'M1,2026-11-11 00:31:00+08:00,cover-close,',
    ];
    expect(freq(report(rows, { maxPerDay: { cover: 1 } }))).toEqual([]);
  });

  it('no limits: settings carry no maxPerDay and an empty object adds nothing', () => {
    const rows = episodes('M1', '2026-11-10', 4);
    const plain = report(rows);
    expect('maxPerDay' in plain.settings).toBe(false);
    expect(jsonReport(report(rows, { maxPerDay: {} }))).toBe(jsonReport(plain));
    expect(jsonReport(report(rows, { maxPerDay: { magnetic: undefined } }))).toBe(jsonReport(plain));
  });

  it('library rejects unknown conditions and bad limits', () => {
    const l = log(episodes('M1', '2026-11-10', 1));
    expect(() => check(l, { maxPerDay: { foo: 1 } as never })).toThrow(/"foo" is not a condition/);
    expect(() => check(l, { maxPerDay: { magnetic: -1 } })).toThrow(/whole number/);
    expect(() => check(l, { maxPerDay: { magnetic: 1.5 } })).toThrow(/whole number/);
  });
});

describe('formats', () => {
  const rows = episodes('M1', '2026-11-10', 3);
  const r = report(rows, { maxPerDay: { magnetic: 2 } });

  it('text lists the finding last in kind order', () => {
    const t = textReport(r);
    expect(t).toContain('Findings: 4 (tamper 3, frequency-exceeded 1)');
    expect(t).toContain('frequency-exceeded (1):\n  - M1 magnetic interference started 3 times on 2026-11-10, over the limit of 2 per day (rows 2, 4, 6)\n');
  });

  it('JSON has settings.maxPerDay and the finding fields', () => {
    const j = JSON.parse(jsonReport(r));
    expect(j.settings.maxPerDay).toEqual({ magnetic: 2 });
    expect(j.findings.at(-1)).toMatchObject({ kind: 'frequency-exceeded', day: '2026-11-10', count: 3, limit: 2, rows: [2, 4, 6] });
  });

  it('Markdown shows the limits in settings and a findings section', () => {
    const md = mdReport(r);
    expect(md).toContain(', max starts per day: magnetic 2.');
    expect(md).toContain('| frequency-exceeded | 1 |');
    expect(md).toContain('### frequency-exceeded: 1\n\n- M1 magnetic interference started 3 times');
  });

  it('CSV appends day, count, limit only with limits', () => {
    const lines = csvReport(r).trimEnd().split('\n');
    expect(lines[0]).toBe([...CSV_HEADER, ...CSV_FREQUENCY_COLUMNS].join(','));
    expect(lines[1]).toMatch(/^tamper,M1,magnetic,.*,,,$/);
    expect(lines.at(-1)).toBe(
      'frequency-exceeded,M1,magnetic,,2026-11-10 01:00,,,,2 4 6,"M1 magnetic interference started 3 times on 2026-11-10, over the limit of 2 per day (rows 2, 4, 6)",2026-11-10,3,2',
    );
    expect(csvReport(report(rows)).split('\n')[0]).toBe(CSV_HEADER.join(','));
    // limits given but nothing exceeded: header with the extra columns, no rows
    expect(csvReport(report(episodes('M1', '2026-11-10', 1, 'power-fail', 'power-restore'), { maxPerDay: { magnetic: 2 } }))).toBe(
      [...CSV_HEADER, ...CSV_FREQUENCY_COLUMNS].join(',') + '\n',
    );
  });

  it('message lists at most 10 rows', () => {
    const many = report(episodes('M1', '2026-11-10', 12), { maxPerDay: { magnetic: 0 } });
    const f = freq(many)[0];
    expect(f.rows).toHaveLength(12);
    expect(f.message).toMatch(/\(rows 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, \.\.\.\)$/);
  });
});

describe('cli --max-per-day', () => {
  it('example: boundary not flagged, repeated starts not counted, multiple conditions, exit 1', () => {
    const r = run([ex('frequency.csv'), '--max-per-day', 'magnetic=3', '--max-per-day', 'cover=1,phase-loss=1']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Findings: 14 (tamper 10, repeated-start 1, frequency-exceeded 3)');
    expect(r.out).toContain(
      [
        'frequency-exceeded (3):',
        '  - MTR-0101 magnetic interference started 4 times on 2026-11-10, over the limit of 3 per day (rows 2, 4, 6, 9)',
        '  - MTR-0103 phase loss started 2 times on 2026-11-10, over the limit of 1 per day (rows 23, 25)',
        '  - MTR-0103 cover open started 2 times on 2026-11-10, over the limit of 1 per day (rows 19, 21)',
      ].join('\n'),
    );
    expect(r.out).not.toMatch(/MTR-0102 magnetic interference started/);
  });

  it('exit 0 when limits are given but none is exceeded and there are no other findings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mec-freq-'));
    const file = join(dir, 'events.csv');
    writeFileSync(file, ['meter,timestamp,event', ...episodes('M1', '2026-11-10', 2, 'power-fail', 'power-restore').map((l) => l.slice(0, -1))].join('\n'));
    const r = run([file, '--max-per-day', 'power=2', '--csv']);
    expect(r.code).toBe(0);
    expect(r.out).toBe([...CSV_HEADER, ...CSV_FREQUENCY_COLUMNS].join(',') + '\n');
    expect(run([file, '--max-per-day', 'power=1', '--csv']).code).toBe(1);
  });

  it.each([['--json'], ['--md'], ['--csv'], []])('%s works with the flag', (...fmt) => {
    const r = run([ex('frequency.csv'), '--max-per-day', 'magnetic=3', ...fmt.filter(Boolean)]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('MTR-0101');
    expect(r.out).toContain(fmt[0] === '--json' ? '"kind": "frequency-exceeded"' : 'frequency-exceeded');
  });

  it.each([['foo=1'], ['magnetic=x'], ['magnetic=-1'], ['magnetic'], ['magnetic=1,magnetic=2'], ['']])('--max-per-day "%s" exits 2', (v) => {
    const r = run([ex('frequency.csv'), '--max-per-day', v]);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/^meter-event-check: --max-per-day/);
  });

  it('--max-per-day without a value exits 2', () => {
    expect(run([ex('frequency.csv'), '--max-per-day']).code).toBe(2);
  });
});
