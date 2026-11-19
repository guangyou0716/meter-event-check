#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check, conditionLabel } from './check.js';
import { InputError } from './errors.js';
import { csvReport, mdReport } from './formats.js';
import { parseDuration, parseEvents, parseMap, parseMaxPerDay } from './input.js';
import { jsonReport, textReport } from './report.js';
import { VOCABULARY } from './vocabulary.js';

const USAGE = `Usage: meter-event-check <events.csv> [options]

Audits a smart-meter event / tamper log (as exported from a head-end system, MDMS or meter reading tool): pairs
start and end events into episodes (cover open, terminal cover open, magnetic interference, reverse energy,
missing neutral, bypass, power failure, phase loss), flags tamper, a cover opened around a power failure, power
failures that hit many meters at once (area outage) versus one meter, and signs of an incomplete or cleared log.
Offline; reads local files only.

events.csv: header "meter,timestamp,event" and an optional "phase" column (L1 / L2 / L3). Every row needs a
            timestamp like 2026-11-10 08:01:00 (T or space, optional seconds, Z or +08:00; one style for the file).
            Each meter's log is replayed by time (equal times keep file order). Exact duplicate rows (same meter,
            timestamp, event and phase, e.g. from overlapping log reads) are dropped and counted.
Events:     built-in names with aliases, matched ignoring case, spaces, underscores and hyphens (see
            --list-events), e.g. power-fail / power-restore, cover-open / cover-close, magnetic-start /
            magnetic-end, log-cleared. Vendor codes: --map map.csv with header "code,event" (event = a built-in
            name). Unknown events are listed in the report and otherwise ignored.

Findings:
  tamper              every cover, terminal cover, magnetic, reverse energy, missing neutral or bypass episode
  tamper-near-outage  cover / terminal cover opened during a power failure of the same meter, or within --near
                      before it starts or after it is restored
  log-cleared         the meter's event log was cleared
  unmatched-end       an end event without a start (log rolled over or events lost)
  repeated-start      a start event while the condition was already active (one finding per episode)
  open-at-end         power failure or phase loss still active at the end of the meter's log
  long-outage         power failure longer than --max-outage (opt-in)
  isolated-outage     power failure not part of an area outage (opt-in, --isolated)
  frequency-exceeded  a meter started a condition more than N times on one calendar day (opt-in, --max-per-day)
A start and its end must have the same phase (empty phase = whole meter).

Area outage: power failures are grouped in time order; a group holds the failures within --outage-window of its
first failure; a group with at least --area-min different meters is an area outage, the other failures are
single-meter outages.

Options:
  --map <file>             vendor code / text to built-in event name (CSV header code,event)
  --near <T>               cover opened this close to a power failure counts (default 5m); T in d / h / m / s
                           (90s, 30m, 1h30m, 1.5h)
  --outage-window <T>      power failures within T of a group's first failure form one group (default 2m)
  --area-min <n>           meters a group needs to be an area outage (default 3, at least 2)
  --max-outage <T>         flag power failures longer than T (long-outage)
  --isolated               flag single-meter power failures (isolated-outage); needs at least --area-min meters
  --max-per-day <c=N,...>  flag a meter whose episodes of condition c start more than N times on one calendar day
                           (frequency-exceeded); day = the date as written in the timestamp; repeatable or comma
                           list, e.g. magnetic=3,cover=1; conditions: power, phase-loss, cover, terminal-cover,
                           magnetic, reverse, neutral, bypass
  --limit <n>              rows listed per section in the text and --md reports (default 50)
  --meter-column <name>    meter id column (default meter)
  --time-column <name>     timestamp column (default timestamp)
  --event-column <name>    event name / code column (default event)
  --phase-column <name>    phase column (default phase, optional)
  --json                   JSON report (summary, conditions, area outages, meters, every finding)
  --md                     Markdown report (summary, conditions, area outages, per-meter table, findings; lists
                           capped by --limit)
  --csv                    CSV, one row per finding (every finding, --limit ignored), columns kind, meter,
                           condition, phase, start, end, duration, duration_ms, rows, detail
                           (pick one of --json, --md, --csv)
  --list-events            print the built-in event names and aliases
  -h, --help               show this help

Exit codes: 0 no findings, 1 findings, 2 input error.
`;

function read(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new InputError(`cannot read ${what} file ${path}: ${(e as Error).message}`);
  }
}

function int(v: string | undefined, flag: string, def: number, min: number, max: number): number {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
    throw new InputError(`${flag} must be a whole number from ${min} to ${max}.`);
  }
  return Number(v);
}

function duration(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const ms = parseDuration(v);
  if (ms === undefined) throw new InputError(`${flag} "${v}" is not a duration like 90s, 5m, 1h30m or 1.5h.`);
  return ms;
}

function listEvents(): string {
  const lines = ['Built-in events (matched ignoring case, spaces, underscores and hyphens):', ''];
  for (const e of VOCABULARY) {
    const m = e.meaning;
    const what = m.kind === 'single' ? m.event : `${m.kind} of ${conditionLabel(m.condition)}`;
    const aliases = e.names.slice(1);
    lines.push(`  ${e.names[0].padEnd(22)} ${what}${aliases.length ? ` (also: ${aliases.join(', ')})` : ''}`);
  }
  return lines.join('\n') + '\n';
}

export function main(argv: string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        map: { type: 'string' },
        near: { type: 'string' },
        'outage-window': { type: 'string' },
        'area-min': { type: 'string' },
        'max-outage': { type: 'string' },
        isolated: { type: 'boolean' },
        'max-per-day': { type: 'string', multiple: true },
        limit: { type: 'string' },
        'meter-column': { type: 'string' },
        'time-column': { type: 'string' },
        'event-column': { type: 'string' },
        'phase-column': { type: 'string' },
        json: { type: 'boolean' },
        md: { type: 'boolean' },
        csv: { type: 'boolean' },
        'list-events': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (values['list-events']) {
      process.stdout.write(listEvents());
      return 0;
    }
    if ([values.json, values.md, values.csv].filter(Boolean).length > 1) throw new InputError('pick one of --json, --md, --csv.');
    const [eventsFile, ...rest] = positionals;
    if (eventsFile === undefined) throw new InputError('missing the events CSV file; see --help.');
    if (rest.length) throw new InputError(`unexpected arguments: ${rest.join(' ')}`);
    const options = {
      nearMs: duration(values.near, '--near'),
      outageWindowMs: duration(values['outage-window'], '--outage-window'),
      areaMin: int(values['area-min'], '--area-min', 3, 2, 1_000_000),
      maxOutageMs: duration(values['max-outage'], '--max-outage'),
      isolated: values.isolated === true,
      ...(values['max-per-day'] && { maxPerDay: parseMaxPerDay(values['max-per-day']) }),
    };
    const limit = int(values.limit, '--limit', 50, 1, 1_000_000);
    const map = values.map === undefined ? undefined : parseMap(read(values.map, 'map'));
    const log = parseEvents(
      read(eventsFile, 'events'),
      {
        meterColumn: values['meter-column'],
        timeColumn: values['time-column'],
        eventColumn: values['event-column'],
        phaseColumn: values['phase-column'],
      },
      map,
    );
    const report = check(log, options);
    process.stdout.write(
      values.json ? jsonReport(report) : values.md ? mdReport(report, limit) : values.csv ? csvReport(report) : textReport(report, limit),
    );
    return report.findings.length ? 1 : 0;
  } catch (e) {
    if (e instanceof InputError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`meter-event-check: ${(e as Error).message}\n`);
      return 2;
    }
    throw e;
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
