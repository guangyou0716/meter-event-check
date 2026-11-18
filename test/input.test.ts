import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration, parseEvents, parseMap, parseStamp } from '../src/input.js';

const H = 'meter,timestamp,event\n';

describe('parseStamp', () => {
  it('accepts ISO-like stamps with and without zone', () => {
    expect(parseStamp('2026-11-10 08:01')).toEqual({ ms: Date.UTC(2026, 10, 10, 8, 1), zoned: false });
    expect(parseStamp('2026-11-10T08:01:30.5Z')).toEqual({ ms: Date.UTC(2026, 10, 10, 8, 1, 30, 500), zoned: true });
    expect(parseStamp('2026-11-10T08:00:00+08:00')!.ms).toBe(Date.UTC(2026, 10, 10, 0, 0));
    expect(parseStamp('2026-11-10 08:00:00 -0130')!.ms).toBe(Date.UTC(2026, 10, 10, 9, 30));
  });
  it('rejects invalid dates', () => {
    for (const s of ['2026-02-30 00:00', '2026-11-10', '10/11/2026 08:00', '2026-11-10 24:00', '2026-11-10 08:00+15:00']) {
      expect(parseStamp(s)).toBeUndefined();
    }
  });
});

describe('durations', () => {
  it('parses and formats', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
    expect(parseDuration('2d')).toBe(172_800_000);
    for (const bad of ['', '5', '0m', '30m1h', '1h1h', 'abc', '-5m']) expect(parseDuration(bad)).toBeUndefined();
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(7_500_000)).toBe('2h05m');
    expect(formatDuration(97_200_000)).toBe('1d03h00m');
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('parseEvents', () => {
  it('reads rows, keeps file order, resolves meanings', () => {
    const log = parseEvents(H + 'M1,2026-11-10 08:00,Power Fail\nM1,2026-11-10 07:00,cover open\nM2,2026-11-10 08:00,relay off\n');
    expect(log.events.map((e) => [e.row, e.meter, e.event])).toEqual([
      [2, 'M1', 'Power Fail'],
      [3, 'M1', 'cover open'],
      [4, 'M2', 'relay off'],
    ]);
    expect(log.events[0].meaning).toEqual({ kind: 'start', condition: 'power' });
    expect(log.events[2].meaning).toBeUndefined();
    expect(log.hasPhase).toBe(false);
    expect(log.zoned).toBe(false);
    expect(log.duplicates).toBe(0);
  });
  it('drops exact duplicates (event and phase compared normalised / case-insensitively)', () => {
    const log = parseEvents(
      'meter,timestamp,event,phase\nM1,2026-11-10 08:00,cover-open,L1\nM1,2026-11-10 08:00:00,Cover Open,l1\nM1,2026-11-10 08:00,cover-open,L2\nM2,2026-11-10 08:00,cover-open,L1\n',
    );
    expect(log.duplicates).toBe(1);
    expect(log.events).toHaveLength(3);
    expect(log.hasPhase).toBe(true);
  });
  it('custom column names', () => {
    const log = parseEvents('No,Time,Code,Ph\nM1,2026-11-10 08:00,1,L3\n', {
      meterColumn: 'no',
      timeColumn: 'TIME',
      eventColumn: 'code',
      phaseColumn: 'ph',
    });
    expect(log.events[0]).toMatchObject({ meter: 'M1', event: '1', phase: 'L3' });
  });
  it('input errors', () => {
    expect(() => parseEvents('')).toThrow(/empty/);
    expect(() => parseEvents('meter,event\nM1,x\n')).toThrow(/no "timestamp" column/);
    expect(() => parseEvents(H)).toThrow(/no rows/);
    expect(() => parseEvents(H + ',2026-11-10 08:00,x\n')).toThrow(/row 2: empty meter/);
    expect(() => parseEvents(H + 'M1,,x\n')).toThrow(/row 2: empty timestamp/);
    expect(() => parseEvents(H + 'M1,2026-11-10 08:00,\n')).toThrow(/row 2: empty event/);
    expect(() => parseEvents(H + 'M1,yesterday,x\n')).toThrow(/row 2: timestamp "yesterday"/);
    expect(() => parseEvents(H + 'M1,2026-11-10 08:00,x\nM1,2026-11-10 09:00Z,x\n')).toThrow(/row 3: .*has time zone, but row 2 has none/);
    expect(() => parseEvents(H + 'M1,2026-11-10 08:00,x\n', { phaseColumn: 'phase' })).toThrow(/no "phase" column/);
  });
  it('map takes priority over the vocabulary', () => {
    const map = parseMap('code,event\npower-fail,cover-open\n');
    const log = parseEvents(H + 'M1,2026-11-10 08:00,Power Fail\n', {}, map);
    expect(log.events[0].meaning).toEqual({ kind: 'start', condition: 'cover' });
  });
});

describe('parseMap', () => {
  it('maps codes to built-in meanings (aliases allowed, same mapping twice is fine)', () => {
    const map = parseMap('Code,Event\n40,Cover Open\n41,cover-closed\n40,meter cover removed\n0x1A,log cleared\n');
    expect(map.get('40')).toEqual({ kind: 'start', condition: 'cover' });
    expect(map.get('41')).toEqual({ kind: 'end', condition: 'cover' });
    expect(map.get('0x1a')).toEqual({ kind: 'single', event: 'log-cleared' });
    expect(map.size).toBe(3);
  });
  it('errors', () => {
    expect(() => parseMap('code\n1\n')).toThrow(/no "event" column/);
    expect(() => parseMap('code,event\n1,relay-off\n')).toThrow(/row 2: "relay-off" is not a known event name/);
    expect(() => parseMap('code,event\n,cover-open\n')).toThrow(/row 2: empty code/);
    expect(() => parseMap('code,event\n1,cover-open\n1,cover-close\n')).toThrow(/row 3: code "1" is already mapped to "cover-open" \(row 2\)/);
    expect(() => parseMap('code,event\n')).toThrow(/no rows/);
  });
});
