import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { ex } from './helpers.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'mec-'));
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

describe('cli', () => {
  it('example: 10 findings, exit 1', () => {
    const r = run([ex('events.csv')]);
    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    expect(r.out).toContain('meter-event-check: 6 meters, 27 events (1 duplicate row dropped), 2026-11-03 14:00:05 .. 2026-11-07 18:00:00');
    expect(r.out).toMatch(/power failure\s+7\s+1\s+6\s+10h09m35s\s+3h30m/);
    expect(r.out).toMatch(/reverse energy \(tamper\)\s+1\s+1\s+1\s+0s\s+-/);
    expect(r.out).toContain('Outages: 7 power failures, 5 in 1 area outage (>= 3 meters within 2m), 2 single-meter');
    expect(r.out).toContain(
      '  - 2026-11-03 14:00:05 (row 2): 5 meters, last failure 2026-11-03 14:01:10, all restored by 2026-11-03 15:21:30',
    );
    expect(r.out).toContain('Log integrity: event log cleared 1 time, clock adjusted 1 time');
    expect(r.out).toContain('  - "relay-disconnect" x1 (first row 27)');
    expect(r.out).toMatch(/MTR-0005\s+0\s+-\s+1\s+2/);
    expect(r.out).toContain('Findings: 10 (tamper 4, tamper-near-outage 2, log-cleared 1, unmatched-end 1, repeated-start 1, open-at-end 1)');
    expect(r.out).toContain(
      'MTR-0002 cover open at 2026-11-03 14:20:00 (row 7) during the power failure from 2026-11-03 14:00:20 (row 3) to 2026-11-03 15:20:10 (row 11), 1h19m50s',
    );
    expect(r.out).toContain('MTR-0004 terminal cover open at 2026-11-05 21:57:00 (row 21) before the power failure');
    expect(r.out).toContain('MTR-0006 reverse energy [L1] from 2026-11-07 11:00:00 (row 28), still active at the end of the log');
  });
  it('json with --max-outage and --isolated', () => {
    const r = run([ex('events.csv'), '--max-outage', '2h', '--isolated', '--json']);
    expect(r.code).toBe(1);
    const d = JSON.parse(r.out);
    expect(d.tool).toBe('meter-event-check');
    expect(d.counts).toEqual({
      tamper: 4,
      'tamper-near-outage': 2,
      'log-cleared': 1,
      'unmatched-end': 1,
      'repeated-start': 1,
      'open-at-end': 1,
      'long-outage': 1,
      'isolated-outage': 2,
    });
    expect(d.summary).toMatchObject({ meters: 6, events: 27, duplicatesDropped: 1, outages: 7, outagesInArea: 5, outagesSingleMeter: 2 });
    expect(d.settings).toEqual({ nearMs: 300_000, outageWindowMs: 120_000, areaMin: 3, maxOutageMs: 7_200_000, isolated: true });
    expect(d.findings.find((f: { kind: string }) => f.kind === 'long-outage')).toMatchObject({ meter: 'MTR-0004', durationMs: 12_600_000 });
    expect(d.findings.filter((f: { kind: string }) => f.kind === 'isolated-outage').map((f: { meter: string }) => f.meter)).toEqual(['MTR-0004', 'MTR-0006']);
  });
  it('vendor codes via --map and custom columns', () => {
    const r = run([
      ex('vendor-events.csv'),
      '--map',
      ex('vendor-map.csv'),
      '--meter-column',
      'meter_no',
      '--time-column',
      'event_time',
      '--event-column',
      'event_code',
      '--json',
    ]);
    const d = JSON.parse(r.out);
    expect(r.code).toBe(1);
    expect(d.counts).toEqual({ tamper: 2, 'log-cleared': 1 });
    expect(d.areaOutages).toEqual([
      { start: '2026-11-10T08:00:00+08:00', row: 2, lastStart: '2026-11-10T08:00:45+08:00', meters: 3, restored: '2026-11-10T08:42:15+08:00' },
    ]);
    expect(d.unknown).toEqual([]);
  });
  it('without --map vendor codes are unknown', () => {
    const r = run([ex('vendor-events.csv'), '--meter-column', 'meter_no', '--time-column', 'event_time', '--event-column', 'event_code']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Unknown events (not built in or in --map; ignored): 11 rows');
    expect(r.out).toContain('No start / end events');
    expect(r.out).toContain('No findings.');
  });
  it('--near, --outage-window, --area-min change the result', () => {
    const near = JSON.parse(run([ex('events.csv'), '--near', '2m', '--json']).out);
    expect(near.counts['tamper-near-outage']).toBe(1);
    const area = JSON.parse(run([ex('events.csv'), '--area-min', '6', '--json']).out);
    expect(area.areaOutages).toEqual([]);
    const win = JSON.parse(run([ex('events.csv'), '--outage-window', '30s', '--area-min', '2', '--json']).out);
    expect(win.areaOutages.map((a: { meters: number }) => a.meters)).toEqual([2, 3]); // 14:00:05+14:00:20, then 14:00:40..14:01:10 (30s, inclusive)
  });
  it('--limit trims text lists', () => {
    const r = run([ex('events.csv'), '--limit', '1']);
    expect(r.out).toContain('  ... 3 more (use --json or a higher --limit)');
    expect(r.out).toContain('  ... 4 more (use --json or a higher --limit)');
  });
  it('exit 0 and "No findings." for a clean log', () => {
    const p = tmp('e.csv', 'meter,timestamp,event\nM1,2026-11-10 08:00,power-fail\nM1,2026-11-10 08:30,power-restore\n');
    const r = run([p]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Outages: 1 power failure, 0 in 0 area outages (>= 3 meters within 2m), 1 single-meter');
    expect(r.out.trimEnd().endsWith('No findings.')).toBe(true);
  });
  it('--md report honours --limit', () => {
    const r = run([ex('events.csv'), '--md', '--limit', '1']);
    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    expect(r.out.startsWith('# Meter event check\n')).toBe(true);
    expect(r.out).toContain('## Findings: 10');
    expect(r.out).toContain('### tamper: 4\n\n- MTR-0002 cover open');
    expect(r.out).toContain('- ... 3 more (use --json or --csv for all, or a higher --limit)');
  });
  it('--csv lists every finding and ignores --limit', () => {
    const r = run([ex('events.csv'), '--csv', '--limit', '1', '--max-outage', '2h', '--isolated']);
    expect(r.code).toBe(1);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('kind,meter,condition,phase,start,end,duration,duration_ms,rows,detail');
    expect(lines).toHaveLength(14);
    expect(lines.filter((l) => l.startsWith('tamper,'))).toHaveLength(4);
    expect(lines[13]).toMatch(/^isolated-outage,MTR-0006,power,,2026-11-07 18:00:00,,,,29,/);
  });
  it('--csv header only and exit 0 for a clean log', () => {
    const p = tmp('e.csv', 'meter,timestamp,event\nM1,2026-11-10 08:00,power-fail\nM1,2026-11-10 08:30,power-restore\n');
    const r = run([p, '--csv']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('kind,meter,condition,phase,start,end,duration,duration_ms,rows,detail\n');
  });
  it.each([
    ['--json', '--md'],
    ['--json', '--csv'],
    ['--md', '--csv'],
  ])('%s with %s is an input error (exit 2)', (a, b) => {
    const r = run([ex('events.csv'), a, b]);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toBe('meter-event-check: pick one of --json, --md, --csv.\n');
  });
  it('--help and --list-events', () => {
    const h = run(['--help']);
    expect(h.code).toBe(0);
    expect(h.out).toContain('Usage: meter-event-check <events.csv> [options]');
    const l = run(['--list-events']);
    expect(l.code).toBe(0);
    expect(l.out).toContain('power-fail             start of power failure (also: power-failure');
    expect(l.out).toContain('log-cleared            log-cleared (also: event-log-cleared, events-cleared)');
  });
  it('input errors exit 2', () => {
    const cases: [string[], RegExp][] = [
      [[], /missing the events CSV file/],
      [[ex('events.csv'), 'x'], /unexpected arguments: x/],
      [['/nonexistent/e.csv'], /cannot read events file/],
      [[ex('events.csv'), '--near', '5'], /--near "5" is not a duration/],
      [[ex('events.csv'), '--max-outage', '0m'], /--max-outage "0m"/],
      [[ex('events.csv'), '--area-min', '1'], /--area-min must be a whole number from 2/],
      [[ex('events.csv'), '--limit', '0'], /--limit must be a whole number from 1/],
      [[ex('events.csv'), '--bogus'], /Unknown option/],
      [[ex('events.csv'), '--map', ex('events.csv')], /map: no "code" column/],
      [[ex('vendor-events.csv')], /events: no "meter" column/],
      [[tmp('e.csv', 'meter,timestamp,event\nM1,2026-11-10 08:00,x\n'), '--isolated'], /--isolated needs at least/],
    ];
    for (const [args, re] of cases) {
      const r = run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toMatch(re);
      expect(r.err.startsWith('meter-event-check: ')).toBe(true);
    }
  });
});
