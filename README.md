# meter-event-check

[![CI](https://github.com/guangyou0716/meter-event-check/actions/workflows/ci.yml/badge.svg)](https://github.com/guangyou0716/meter-event-check/actions/workflows/ci.yml)

Offline CLI and TypeScript library that audits a **smart-meter event / tamper log** exported as CSV from a
head-end system, MDMS or meter reading tool. It answers the questions a revenue-protection or AMI operations
engineer usually works out by filtering in Excel:

- Which meters had **cover / terminal cover open, magnetic interference, reverse energy, missing neutral or
  bypass**, from when to when and for how long (or still active)?
- Was a cover opened **during a power failure** of that meter, or just before / after it (a common rewiring
  pattern)?
- Was a power failure an **area outage** (many meters at the same moment) or a **single-meter outage**?
- Does the log look **incomplete or tampered with**: event log cleared, an end event without its start (log
  roll-over), a start repeated while already active, a power failure or phase loss that never ends?

No network, no runtime dependencies, synthetic examples only. Not a replacement for the meter vendor's or the
utility's revenue-protection rules: it lists evidence, it does not decide that a customer tampered.

## Install and run

```sh
git clone https://github.com/guangyou0716/meter-event-check.git
cd meter-event-check
npm ci && npm run build
node dist/cli.js examples/events.csv
```

Node 20 or newer.

## Input

`events.csv` with a header row:

| column      | required | meaning                                                                     |
|-------------|----------|-----------------------------------------------------------------------------|
| `meter`     | yes      | meter id / serial                                                            |
| `timestamp` | yes      | `2026-11-10 08:01:00` (T or space, optional seconds, `Z` or `+08:00`; one style per file) |
| `event`     | yes      | event name (built in, see below) or a vendor code mapped with `--map`         |
| `phase`     | no       | `L1` / `L2` / `L3`; a start and its end must have the same phase (empty = whole meter) |

Column names can be changed with `--meter-column`, `--time-column`, `--event-column`, `--phase-column`.
Each meter's log is replayed by time (equal times keep file order). Exact duplicate rows (same meter, timestamp,
event and phase, e.g. from overlapping log reads) are dropped and counted.

### Event names

Built-in names are matched ignoring case, spaces, underscores and hyphens (`Cover_Open` = `cover open` =
`cover-open`). `meter-event-check --list-events` prints all of them with aliases.

| condition              | start (examples)                         | end (examples)                          | tamper |
|------------------------|------------------------------------------|-----------------------------------------|--------|
| power failure          | `power-fail`, `power-off`, `power-down`  | `power-restore`, `power-on`, `power-up` | no     |
| phase loss             | `phase-loss`, `voltage-missing`          | `phase-restore`, `voltage-restored`     | no     |
| cover open             | `cover-open`, `meter-cover-removed`      | `cover-close`, `cover-closed`           | yes    |
| terminal cover open    | `terminal-cover-open`, `terminal-cover-removed` | `terminal-cover-close`           | yes    |
| magnetic interference  | `magnetic-start`, `magnetic-tamper`, `magnet-detected` | `magnetic-end`, `magnet-removed` | yes |
| reverse energy         | `reverse-start`, `reverse-energy`, `reverse-current` | `reverse-end`, `reverse-energy-end` | yes |
| missing neutral        | `neutral-missing`, `missing-neutral`, `neutral-disturbance` | `neutral-restore`, `neutral-missing-end` | yes |
| bypass                 | `bypass-start`, `bypass`, `meter-bypass` | `bypass-end`                            | yes    |

Single events: `log-cleared` (`event-log-cleared`) and `clock-adjusted` (`clock-set`, `time-set`, ...).
Anything else is listed under "Unknown events" and otherwise ignored.

Vendor logs often carry numeric codes (and codes differ per vendor and firmware). Map them with `--map map.csv`:

```csv
code,event
1,power-fail
2,power-restore
40,cover-open
41,cover-close
255,log-cleared
```

## Findings

| kind                 | when                                                                                         |
|----------------------|----------------------------------------------------------------------------------------------|
| `tamper`             | every cover, terminal cover, magnetic, reverse energy, missing neutral or bypass episode      |
| `tamper-near-outage` | cover / terminal cover opened during a power failure of the same meter, or within `--near` (default 5m) before it starts or after it is restored |
| `log-cleared`        | the meter's event log was cleared                                                            |
| `unmatched-end`      | an end event without a start (log rolled over or events lost)                                |
| `repeated-start`     | a start event while the condition was already active (one finding per episode, with rows)    |
| `open-at-end`        | power failure or phase loss still active at the end of the meter's log                       |
| `long-outage`        | power failure longer than `--max-outage` (opt-in)                                             |
| `isolated-outage`    | power failure that is not part of an area outage (opt-in, `--isolated`)                       |

**Area outage**: power failures are taken in time order; a group holds the failures within `--outage-window`
(default 2m) of its first failure (anchored, so a busy fleet does not chain into one endless group); a group with
at least `--area-min` (default 3) different meters is an area outage, every other failure is a single-meter outage.

Exit codes: `0` no findings, `1` findings, `2` input error.

## Example

`examples/events.csv` is a small synthetic log of six meters:

```text
$ meter-event-check examples/events.csv
meter-event-check: 6 meters, 27 events (1 duplicate row dropped), 2026-11-03 14:00:05 .. 2026-11-07 18:00:00

Condition                       episodes  ongoing  meters      total  longest
power failure                          7        1       6  10h09m35s    3h30m
phase loss                             1        0       1        45m      45m
cover open (tamper)                    1        0       1        15m      15m
terminal cover open (tamper)           1        0       1        43m      43m
magnetic interference (tamper)         1        0       1      1h30m    1h30m
reverse energy (tamper)                1        1       1         0s        -
(total / longest over closed episodes; ongoing = still active at the end of the meter's log)

Outages: 7 power failures, 5 in 1 area outage (>= 3 meters within 2m), 2 single-meter
  - 2026-11-03 14:00:05 (row 2): 5 meters, last failure 2026-11-03 14:01:10, all restored by 2026-11-03 15:21:30
Log integrity: event log cleared 1 time, clock adjusted 1 time
Unknown events (not built in or in --map; ignored): 1 row
  - "relay-disconnect" x1 (first row 27)

Meters with tamper or findings (most tamper first):
  meter     tamper  tamper time  outages  findings
  MTR-0002       1          15m        1         2
  MTR-0003       1        1h30m        1         2
  MTR-0004       1          43m        2         2
  MTR-0006       1           0s        1         2
  MTR-0005       0            -        1         2

Findings: 10 (tamper 4, tamper-near-outage 2, log-cleared 1, unmatched-end 1, repeated-start 1, open-at-end 1)

tamper (4):
  - MTR-0002 cover open from 2026-11-03 14:20:00 (row 7) to 2026-11-03 14:35:00 (row 8), 15m
  - MTR-0003 magnetic interference from 2026-11-04 02:00:00 (row 15) to 2026-11-04 03:30:00 (row 17), 1h30m
  - MTR-0004 terminal cover open from 2026-11-05 21:57:00 (row 21) to 2026-11-05 22:40:00 (row 23), 43m
  - MTR-0006 reverse energy [L1] from 2026-11-07 11:00:00 (row 28), still active at the end of the log

tamper-near-outage (2):
  - MTR-0002 cover open at 2026-11-03 14:20:00 (row 7) during the power failure from 2026-11-03 14:00:20 (row 3) to 2026-11-03 15:20:10 (row 11), 1h19m50s
  - MTR-0004 terminal cover open at 2026-11-05 21:57:00 (row 21) before the power failure from 2026-11-05 22:00:00 (row 22) to 2026-11-06 01:30:00 (row 24), 3h30m

log-cleared (1):
  - MTR-0005 event log cleared at 2026-11-06 09:00:00 (row 25)

unmatched-end (1):
  - MTR-0005 "cover-close" at 2026-11-06 09:05:00 (row 26) ends a cover open that never started in the log

repeated-start (1):
  - MTR-0003 magnetic interference started again 1 time(s) while already active since 2026-11-04 02:00:00 (row 15; rows 16)

open-at-end (1):
  - MTR-0006 power failure from 2026-11-07 18:00:00 (row 29), still active at the end of the log
```

Opt-in checks and JSON:

```sh
meter-event-check examples/events.csv --max-outage 2h --isolated --json
# vendor codes and column names
meter-event-check examples/vendor-events.csv --map examples/vendor-map.csv \
  --meter-column meter_no --time-column event_time --event-column event_code
```

`--json` prints the summary, settings, per-condition statistics, area outages, meters ranked by tamper, unknown
events, counts per finding kind and every finding (with meter, condition, phase, start, end, duration in ms and
file rows).

## Options

```text
--map <file>             vendor code / text to built-in event name (CSV header code,event)
--near <T>               cover opened this close to a power failure counts (default 5m)
--outage-window <T>      power failures within T of a group's first failure form one group (default 2m)
--area-min <n>           meters a group needs to be an area outage (default 3, at least 2)
--max-outage <T>         flag power failures longer than T (long-outage)
--isolated               flag single-meter power failures; needs at least --area-min meters in the log
--limit <n>              rows listed per section in the text report (default 50)
--meter-column / --time-column / --event-column / --phase-column <name>
--json                   JSON report
--list-events            built-in event names and aliases
```

Durations `T`: `90s`, `5m`, `1h30m`, `1.5h`, `2d`.

## Library

```ts
// not published to npm; import from the build in a clone
import { readFileSync } from 'node:fs';
import { check, parseEvents, parseMap, textReport } from './dist/index.js';

const log = parseEvents(readFileSync('events.csv', 'utf8'), {}, parseMap(readFileSync('map.csv', 'utf8')));
const report = check(log, { maxOutageMs: 2 * 3_600_000, isolated: true });
console.log(report.counts, textReport(report));
```

## Limits

- Episodes come only from the events in the file: a log that rolled over loses starts (reported as
  `unmatched-end`), and a condition active before the first exported event cannot be seen.
- Durations use the meter's own timestamps; clock adjustments are counted but not corrected.
- Timestamps without a zone are compared as written; area outage grouping across meters assumes one clock basis.
- The vocabulary covers common IDIS / DLMS-style event names; vendor-specific codes need a `--map` file.

## Development

```sh
npm run lint && npm run typecheck && npm test && npm run build && npm run smoke
```

The smoke run builds a synthetic 100,000-row log (2,000 meters x 50 events) and checks the counts.

## Licence

MIT
