import { describe, expect, it } from 'vitest';
import { CONDITIONS, TAMPER_CONDITIONS, VOCABULARY, canonicalName, isTamper, lookupEvent, normaliseEvent } from '../src/vocabulary.js';

describe('vocabulary', () => {
  it('normalises case, spaces, underscores, dots and hyphens', () => {
    expect(normaliseEvent('  Cover_Open ')).toBe('cover-open');
    expect(normaliseEvent('Terminal  Cover -- Removed')).toBe('terminal-cover-removed');
    expect(normaliseEvent('power.fail')).toBe('power-fail');
    expect(normaliseEvent('-x-')).toBe('x');
  });
  it('looks up names and aliases', () => {
    expect(lookupEvent('Power Failure')).toEqual({ kind: 'start', condition: 'power' });
    expect(lookupEvent('POWER_ON')).toEqual({ kind: 'end', condition: 'power' });
    expect(lookupEvent('Missing neutral')).toEqual({ kind: 'start', condition: 'neutral' });
    expect(lookupEvent('magnet removed')).toEqual({ kind: 'end', condition: 'magnetic' });
    expect(lookupEvent('event log cleared')).toEqual({ kind: 'single', event: 'log-cleared' });
    expect(lookupEvent('after clock adjusted')).toEqual({ kind: 'single', event: 'clock-adjusted' });
    expect(lookupEvent('relay-disconnect')).toBeUndefined();
  });
  it('has no name twice and every condition has a start and an end', () => {
    const names = VOCABULARY.flatMap((e) => e.names);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(normaliseEvent(n)).toBe(n);
    for (const c of CONDITIONS) {
      expect(VOCABULARY.some((e) => e.meaning.kind === 'start' && e.meaning.condition === c)).toBe(true);
      expect(VOCABULARY.some((e) => e.meaning.kind === 'end' && e.meaning.condition === c)).toBe(true);
    }
  });
  it('tamper conditions and canonical names', () => {
    expect(TAMPER_CONDITIONS).toEqual(['cover', 'terminal-cover', 'magnetic', 'reverse', 'neutral', 'bypass']);
    expect(isTamper('power')).toBe(false);
    expect(isTamper('phase-loss')).toBe(false);
    expect(isTamper('bypass')).toBe(true);
    expect(canonicalName({ kind: 'end', condition: 'cover' })).toBe('cover-close');
  });
});
