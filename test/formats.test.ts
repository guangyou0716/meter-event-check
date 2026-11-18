import { describe, expect, it } from 'vitest';
import { check } from '../src/check.js';
import { CSV_HEADER, csvCell, csvReport, mdCell, mdReport } from '../src/formats.js';
import { parseEvents } from '../src/input.js';

const report = (rows: string[], options = {}) => check(parseEvents(['meter,timestamp,event,phase', ...rows].join('\n')), options);

const csvRows = (text: string) => text.trimEnd().split('\n');

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['', ''],
    [undefined, ''],
    [null, ''],
    [0, '0'],
    [900000, '900000'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['=1+1', "'=1+1"],
    ['+60', "'+60"],
    ['-5', "'-5"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tx', "'\tx"],
    ['\rx', `"'\rx"`],
    ['=a,b', `"'=a,b"`],
    ['a=b', 'a=b'],
  ])('%j -> %j', (v, want) => {
    expect(csvCell(v as string | number | null | undefined)).toBe(want);
  });
});

describe('mdCell', () => {
  it('escapes pipes and backslashes, flattens line breaks', () => {
    expect(mdCell('a|b\\c')).toBe('a\\|b\\\\c');
    expect(mdCell('x\r\ny\nz\rw')).toBe('x y z w');
    expect(mdCell(5)).toBe('5');
  });
});

describe('csvReport', () => {
  it('header only when there are no findings', () => {
    const r = report(['M1,2026-11-10 08:00,power-fail,', 'M1,2026-11-10 08:30,power-restore,']);
    expect(csvReport(r)).toBe(`${CSV_HEADER.join(',')}\n`);
  });
  it('one row per finding in kind order with episode fields; empty end / duration when still active', () => {
    const r = report(
      [
        'M2,2026-11-10 09:00,log-cleared,',
        'M1,2026-11-10 08:00,cover-open,',
        'M1,2026-11-10 08:15,cover-close,',
        'M3,2026-11-10 10:00,reverse-start,L2',
      ],
    );
    const lines = csvRows(csvReport(r));
    expect(lines[0]).toBe('kind,meter,condition,phase,start,end,duration,duration_ms,rows,detail');
    expect(lines.slice(1).map((l) => l.split(',').slice(0, 2).join(','))).toEqual(['tamper,M1', 'tamper,M3', 'log-cleared,M2']);
    expect(lines[1]).toBe(
      'tamper,M1,cover,,2026-11-10 08:00,2026-11-10 08:15,15m,900000,3 4,"M1 cover open from 2026-11-10 08:00 (row 3) to 2026-11-10 08:15 (row 4), 15m"',
    );
    expect(lines[2]).toMatch(/^tamper,M3,reverse,L2,2026-11-10 10:00,,,,5,"M3 reverse energy \[L2\]/);
    expect(lines[3]).toBe('log-cleared,M2,,,2026-11-10 09:00,,,,2,M2 event log cleared at 2026-11-10 09:00 (row 2)');
  });
  it('guards meter ids that look like formulas and quotes commas', () => {
    const r = check(
      parseEvents('meter,timestamp,event\n"=HYPERLINK(""x"",1)",2026-11-10 08:00,log-cleared\n'),
    );
    const line = csvRows(csvReport(r))[1];
    expect(line.startsWith('log-cleared,"\'=HYPERLINK(""x"",1)",')).toBe(true);
  });
  it('lists every finding regardless of count', () => {
    const rows = Array.from({ length: 120 }, (_, i) => `M${i},2026-11-10 08:00,log-cleared,`);
    expect(csvRows(csvReport(report(rows)))).toHaveLength(121);
  });
});

describe('mdReport', () => {
  const r = report([
    'M1,2026-11-10 08:00,power-fail,',
    'M2,2026-11-10 08:00:30,power-fail,',
    'M3,2026-11-10 08:01,power-fail,',
    'M1,2026-11-10 08:10,cover-open,',
    'M1,2026-11-10 08:20,cover-close,',
    'M1,2026-11-10 09:00,power-restore,',
    'M2,2026-11-10 09:00,power-restore,',
    'M3,2026-11-10 09:05,power-restore,',
    'M4,2026-11-10 10:00,mystery-code,',
    'M5,2026-11-10 10:00,log-cleared,',
    'M6,2026-11-10 10:00,log-cleared,',
  ]);
  it('summary, conditions, area outages, unknown events, meters and findings', () => {
    const md = mdReport(r);
    expect(md.startsWith('# Meter event check\n')).toBe(true);
    expect(md).toContain('| 6 | 11 | 0 | 2026-11-10 08:00 | 2026-11-10 10:00 | 3 | 3 | 0 | 2 | 0 | 1 |');
    expect(md).toContain('Settings: near 5m, outage window 2m, area outage >= 3 meters.');
    expect(md).toContain('| power failure | no | 3 | 0 | 3 | 3h03m30s | 1h04m |');
    expect(md).toContain('| cover open | yes | 1 | 0 | 1 | 10m | 10m |');
    expect(md).toContain('## Area outages: 1');
    expect(md).toContain('| 2026-11-10 08:00 | 2 | 2026-11-10 08:01 | 3 | 2026-11-10 09:05 |');
    expect(md).toContain('## Unknown events: 1 row');
    expect(md).toContain('| mystery-code | 1 | 10 |');
    expect(md).toContain('## Meters with tamper or findings: 3');
    expect(md).toContain('| M1 | 4 | 1 | 10m | 1 | 2 |');
    expect(md).toContain('| M5 | 1 | 0 | - | 0 | 1 |');
    expect(md).toContain('## Findings: 4');
    expect(md).toContain('| tamper | 1 |\n| tamper-near-outage | 1 |\n| log-cleared | 2 |');
    expect(md).toContain('### log-cleared: 2\n\n- M5 event log cleared');
    expect(md).not.toContain('more (use');
  });
  it('--limit caps lists and tables with a "more" line', () => {
    const md = mdReport(r, 1);
    expect(md).toContain('### log-cleared: 2\n\n- M5 event log cleared at 2026-11-10 10:00 (row 11)\n- ... 1 more (use --json or --csv for all, or a higher --limit)');
    expect(md).toContain('| M1 | 4 | 1 | 10m | 1 | 2 |\n\n- ... 2 more');
  });
  it('settings line shows opt-in checks; no findings and no episodes', () => {
    const empty = report(['M1,2026-11-10 08:00,clock-adjusted,', 'M2,2026-11-10 08:00,clock-adjusted,', 'M3,2026-11-10 08:00,clock-adjusted,'], { maxOutageMs: 7_200_000, isolated: true });
    const md = mdReport(empty);
    expect(md).toContain('Settings: near 5m, outage window 2m, area outage >= 3 meters, max outage 2h00m, isolated outages flagged.');
    expect(md).toContain('No start / end events');
    expect(md).toContain('## Area outages: 0\n\nNone.');
    expect(md).not.toContain('## Meters');
    expect(md.trimEnd().endsWith('No findings.')).toBe(true);
  });
  it('escapes pipes in meter ids and event names', () => {
    const md = mdReport(check(parseEvents('meter,timestamp,event\nA|1,2026-11-10 08:00,log-cleared\nB,2026-11-10 08:00,x|y\n')));
    expect(md).toContain('| A\\|1 | 1 | 0 | - | 0 | 1 |');
    expect(md).toContain('| x\\|y | 1 | 3 |');
    expect(md).toContain('- A\\|1 event log cleared');
  });
});
