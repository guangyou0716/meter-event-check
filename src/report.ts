import { FINDING_KINDS, type Report, conditionLabel } from './check.js';
import { formatDuration } from './input.js';

function pad(rows: string[][], right: boolean[]): string[] {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((v, c) => (right[c] ? v.padStart(widths[c]) : v.padEnd(widths[c]))).join('  ').trimEnd());
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Plain-text report; findings listed per kind, at most `limit` each. */
export function textReport(r: Report, limit = 50): string {
  const s = r.summary;
  const out: string[] = [];
  const dup = s.duplicatesDropped ? ` (${plural(s.duplicatesDropped, 'duplicate row')} dropped)` : '';
  out.push(`meter-event-check: ${plural(s.meters, 'meter')}, ${plural(s.events, 'event')}${dup}, ${s.from} .. ${s.to}`);
  out.push('');

  const used = r.conditions.filter((c) => c.episodes > 0);
  if (used.length) {
    const rows = [['Condition', 'episodes', 'ongoing', 'meters', 'total', 'longest']];
    for (const c of used) {
      rows.push([
        `${conditionLabel(c.condition)}${c.tamper ? ' (tamper)' : ''}`,
        String(c.episodes),
        String(c.ongoing),
        String(c.meters),
        formatDuration(c.totalMs),
        c.longestMs === null ? '-' : formatDuration(c.longestMs),
      ]);
    }
    out.push(...pad(rows, [false, true, true, true, true, true]));
    out.push('(total / longest over closed episodes; ongoing = still active at the end of the meter\'s log)');
  } else {
    out.push('No start / end events (power, phase loss, cover, magnetic, ...) in the log.');
  }
  out.push('');

  const st = r.settings;
  out.push(
    `Outages: ${plural(s.outages, 'power failure')}, ${s.outagesInArea} in ${plural(r.areaOutages.length, 'area outage')} ` +
      `(>= ${st.areaMin} meters within ${formatDuration(st.outageWindowMs)}), ${s.outagesSingleMeter} single-meter`,
  );
  for (const a of r.areaOutages.slice(0, limit)) {
    const last = a.lastStart !== a.start ? `, last failure ${a.lastStart}` : '';
    out.push(`  - ${a.start} (row ${a.row}): ${plural(a.meters, 'meter')}${last}, ${a.restored ? `all restored by ${a.restored}` : 'not all restored in the log'}`);
  }
  if (r.areaOutages.length > limit) out.push(`  ... ${r.areaOutages.length - limit} more (use --json or a higher --limit)`);
  out.push(`Log integrity: event log cleared ${plural(s.logCleared, 'time')}, clock adjusted ${plural(s.clockAdjusted, 'time')}`);
  if (r.unknown.length) {
    out.push(`Unknown events (not built in or in --map; ignored): ${plural(s.unknownEvents, 'row')}`);
    for (const u of r.unknown.slice(0, limit)) out.push(`  - "${u.event}" x${u.count} (first row ${u.firstRow})`);
    if (r.unknown.length > limit) out.push(`  ... ${r.unknown.length - limit} more`);
  }
  out.push('');

  if (r.meters.length) {
    out.push('Meters with tamper or findings (most tamper first):');
    const rows = [['meter', 'tamper', 'tamper time', 'outages', 'findings']];
    for (const m of r.meters.slice(0, limit)) {
      rows.push([m.meter, String(m.tamperEpisodes), m.tamperEpisodes ? formatDuration(m.tamperMs) : '-', String(m.outages), String(m.findings)]);
    }
    out.push(...pad(rows, [false, true, true, true, true]).map((l) => `  ${l}`));
    if (r.meters.length > limit) out.push(`  ... ${r.meters.length - limit} more (use --json or a higher --limit)`);
    out.push('');
  }

  if (!r.findings.length) {
    out.push('No findings.');
    return out.join('\n') + '\n';
  }
  const counts = FINDING_KINDS.filter((k) => r.counts[k]).map((k) => `${k} ${r.counts[k]}`);
  out.push(`Findings: ${r.findings.length} (${counts.join(', ')})`);
  for (const kind of FINDING_KINDS) {
    const list = r.findings.filter((f) => f.kind === kind);
    if (!list.length) continue;
    out.push('');
    out.push(`${kind} (${list.length}):`);
    for (const f of list.slice(0, limit)) out.push(`  - ${f.message}`);
    if (list.length > limit) out.push(`  ... ${list.length - limit} more (use --json or a higher --limit)`);
  }
  return out.join('\n') + '\n';
}

/** JSON report: everything, no limits. */
export function jsonReport(r: Report): string {
  return JSON.stringify({ tool: 'meter-event-check', ...r }, null, 2) + '\n';
}
