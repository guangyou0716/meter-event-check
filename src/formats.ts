import { FINDING_KINDS, type Finding, type Report, conditionLabel } from './check.js';
import { formatDuration } from './input.js';

/**
 * One CSV cell (RFC 4180): quoted when it holds a quote, comma or line break. Cells starting with = + - @ tab or CR
 * get a leading ' so spreadsheets do not run them as formulas.
 */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (cells: (string | number | null | undefined)[]) => cells.map(csvCell).join(',');

/** Markdown table / list text: backslashes and pipes escaped, line breaks flattened. */
export const mdCell = (v: string | number) => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');

export const CSV_HEADER = ['kind', 'meter', 'condition', 'phase', 'start', 'end', 'duration', 'duration_ms', 'rows', 'detail'];

/** Columns appended to the CSV only when frequency limits (--max-per-day) were given. */
export const CSV_FREQUENCY_COLUMNS = ['day', 'count', 'limit'];

const byKind = (findings: Finding[]) => [...findings].sort((a, b) => FINDING_KINDS.indexOf(a.kind) - FINDING_KINDS.indexOf(b.kind));

/**
 * Findings as CSV, one row per finding (all of them, --limit is ignored), in the text report's kind order. File rows
 * inside a cell are space separated; end and duration are empty when the episode is still active (or not an
 * episode). No findings = header only. With frequency limits the columns day, count and limit are appended (filled
 * for frequency-exceeded only).
 */
export function csvReport(r: Report): string {
  const freq = r.settings.maxPerDay !== undefined;
  const lines = [csvLine(freq ? [...CSV_HEADER, ...CSV_FREQUENCY_COLUMNS] : CSV_HEADER)];
  for (const f of byKind(r.findings)) {
    const ms = typeof f.durationMs === 'number' ? f.durationMs : undefined;
    lines.push(
      csvLine([
        f.kind,
        f.meter,
        f.condition,
        f.phase,
        f.start,
        f.end,
        ms === undefined ? undefined : formatDuration(ms),
        ms,
        f.rows.join(' '),
        f.message,
        ...(freq ? [f.day, f.count, f.limit] : []),
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const more = (n: number) => `- ... ${n} more (use --json or --csv for all, or a higher --limit)`;

/**
 * Markdown report: summary, conditions, area outages, unknown events, per-meter summary and findings per kind (each
 * list / table capped at `limit`, like the text report).
 */
export function mdReport(r: Report, limit = 50): string {
  const s = r.summary;
  const st = r.settings;
  const out = [
    '# Meter event check',
    '',
    '| meters | events | duplicate rows dropped | from | to | power failures | in area outages | single-meter | log cleared | clock adjusted | unknown event rows |',
    '| ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${s.meters} | ${s.events} | ${s.duplicatesDropped} | ${mdCell(s.from)} | ${mdCell(s.to)} | ${s.outages} | ${s.outagesInArea} | ${s.outagesSingleMeter} | ${s.logCleared} | ${s.clockAdjusted} | ${s.unknownEvents} |`,
    '',
    `Settings: near ${formatDuration(st.nearMs)}, outage window ${formatDuration(st.outageWindowMs)}, area outage >= ${st.areaMin} meters` +
      `${st.maxOutageMs === null ? '' : `, max outage ${formatDuration(st.maxOutageMs)}`}${st.isolated ? ', isolated outages flagged' : ''}` +
      `${st.maxPerDay ? `, max starts per day: ${Object.entries(st.maxPerDay).map(([c, n]) => `${c} ${n}`).join(', ')}` : ''}.`,
    '',
    '## Conditions',
    '',
  ];

  const used = r.conditions.filter((c) => c.episodes > 0);
  if (used.length) {
    out.push('| condition | tamper | episodes | ongoing | meters | total | longest |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const c of used) {
      out.push(
        `| ${conditionLabel(c.condition)} | ${c.tamper ? 'yes' : 'no'} | ${c.episodes} | ${c.ongoing} | ${c.meters} | ${formatDuration(c.totalMs)} | ${c.longestMs === null ? '-' : formatDuration(c.longestMs)} |`,
      );
    }
    out.push('', "Total / longest over closed episodes; ongoing = still active at the end of the meter's log.");
  } else {
    out.push('No start / end events (power, phase loss, cover, magnetic, ...) in the log.');
  }

  out.push('', `## Area outages: ${r.areaOutages.length}`, '');
  if (r.areaOutages.length) {
    out.push('| first failure | row | last failure | meters | all restored by |', '| --- | ---: | --- | ---: | --- |');
    for (const a of r.areaOutages.slice(0, limit)) {
      out.push(`| ${mdCell(a.start)} | ${a.row} | ${mdCell(a.lastStart)} | ${a.meters} | ${a.restored === null ? 'not all restored in the log' : mdCell(a.restored)} |`);
    }
    if (r.areaOutages.length > limit) out.push('', more(r.areaOutages.length - limit));
  } else {
    out.push('None.');
  }

  if (r.unknown.length) {
    out.push('', `## Unknown events: ${plural(s.unknownEvents, 'row')}`, '', 'Not built in or in --map; ignored.', '');
    out.push('| event | rows | first row |', '| --- | ---: | ---: |');
    for (const u of r.unknown.slice(0, limit)) out.push(`| ${mdCell(u.event)} | ${u.count} | ${u.firstRow} |`);
    if (r.unknown.length > limit) out.push('', more(r.unknown.length - limit));
  }

  if (r.meters.length) {
    out.push('', `## Meters with tamper or findings: ${r.meters.length}`, '', 'Most tamper first.', '');
    out.push('| meter | events | tamper episodes | tamper time | outages | findings |', '| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const m of r.meters.slice(0, limit)) {
      out.push(`| ${mdCell(m.meter)} | ${m.events} | ${m.tamperEpisodes} | ${m.tamperEpisodes ? formatDuration(m.tamperMs) : '-'} | ${m.outages} | ${m.findings} |`);
    }
    if (r.meters.length > limit) out.push('', more(r.meters.length - limit));
  }

  if (!r.findings.length) {
    out.push('', 'No findings.');
    return out.join('\n') + '\n';
  }
  out.push('', `## Findings: ${r.findings.length}`, '', '| kind | count |', '| --- | ---: |');
  for (const kind of FINDING_KINDS) if (r.counts[kind]) out.push(`| ${kind} | ${r.counts[kind]} |`);
  for (const kind of FINDING_KINDS) {
    const list = r.findings.filter((f) => f.kind === kind);
    if (!list.length) continue;
    out.push('', `### ${kind}: ${list.length}`, '');
    for (const f of list.slice(0, limit)) out.push(`- ${mdCell(f.message)}`);
    if (list.length > limit) out.push(more(list.length - limit));
  }
  return out.join('\n') + '\n';
}
