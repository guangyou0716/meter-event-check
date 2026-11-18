import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv.js';

describe('parseCsv', () => {
  it('quotes, escaped quotes, CRLF, BOM, blank lines', () => {
    expect(parseCsv('\ufeffa,b\r\n"x, y","say ""hi"""\r\n\r\n1,2')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['1', '2'],
    ]);
  });
  it('errors on broken quoting', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/not closed/);
    expect(() => parseCsv('a,b"c\n')).toThrow(/line 1: unexpected quote/);
    expect(() => parseCsv('"a"b\n')).toThrow(/line 1: unexpected text after a closing quote/);
  });
});
