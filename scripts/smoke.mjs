#!/usr/bin/env node
// Smoke run on a synthetic 100,000-row event log (2,000 meters x 50 events). Needs `npm run build` first.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'meter-event-check-smoke-'));
const fail = (msg) => {
  console.error(`smoke: FAIL ${msg}`);
  process.exit(1);
};
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

const METERS = 2000;
const PAIRS = 23;
const MIN = 60_000;
const day1 = Date.UTC(2026, 10, 1, 10, 0, 0);
const t0 = Date.UTC(2026, 10, 2, 0, 0, 0);
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const meter = (i) => `M-${String(i).padStart(5, '0')}`;

const lines = ['meter,timestamp,event'];
// Distinct meter / calendar day pairs with a power failure start (expected frequency-exceeded at power=0).
const powerDays = new Set();
for (let i = 0; i < METERS; i++) {
  const m = meter(i);
  // Area outage: every meter fails within the first minute of 10:00 and is restored at 11:00.
  lines.push(`${m},${stamp(day1 + (i % 60) * 1000)},power-fail`, `${m},${stamp(day1 + 60 * MIN)},power-restore`);
  powerDays.add(`${m} ${stamp(day1).slice(0, 10)}`);
  // 1 in 100 meters: cover opened during the area outage (tamper + tamper-near-outage); the rest: two clock syncs.
  if (i % 100 === 0) lines.push(`${m},${stamp(day1 + 30 * MIN)},cover-open`, `${m},${stamp(day1 + 40 * MIN)},cover-close`);
  else lines.push(`${m},${stamp(day1 + 2 * 60 * MIN)},clock-adjusted`, `${m},${stamp(day1 + 3 * 60 * MIN)},clock-adjusted`);
  // Single-meter outages 3 minutes apart across the fleet (never within the 2-minute window), 1 minute long.
  for (let k = 0; k < PAIRS; k++) {
    const s = t0 + (k * METERS + i) * 3 * MIN;
    lines.push(`${m},${stamp(s)},power-fail`, `${m},${stamp(s + MIN)},power-restore`);
    powerDays.add(`${m} ${stamp(s).slice(0, 10)}`);
  }
}
if (lines.length - 1 !== 100_000) fail(`generated ${lines.length - 1} rows`);
const file = join(dir, 'events.csv');
writeFileSync(file, lines.join('\n') + '\n');

const t1 = Date.now();
const r = run([file, '--json']);
const ms1 = Date.now() - t1;
const d = r.stdout ? JSON.parse(r.stdout) : {};
if (
  r.status !== 1 ||
  d.summary?.meters !== METERS ||
  d.summary?.events !== 100_000 ||
  d.summary?.outages !== METERS * (PAIRS + 1) ||
  d.summary?.outagesInArea !== METERS ||
  d.summary?.clockAdjusted !== 2 * (METERS - 20) ||
  d.areaOutages?.length !== 1 ||
  d.areaOutages[0].meters !== METERS ||
  JSON.stringify(d.counts) !== JSON.stringify({ tamper: 20, 'tamper-near-outage': 20 })
) {
  fail(`default: status ${r.status} ${JSON.stringify(d.summary)} ${JSON.stringify(d.counts)} ${r.stderr}`);
}
console.log(`smoke: ok 100,000 rows / ${METERS} meters in ${ms1} ms: 1 area outage of ${METERS} meters, 20 tamper, 20 near outage`);

const t2 = Date.now();
const r2 = run([file, '--json', '--isolated', '--max-outage', '30m']);
const ms2 = Date.now() - t2;
const d2 = r2.stdout ? JSON.parse(r2.stdout) : {};
if (r2.status !== 1 || d2.counts?.['isolated-outage'] !== METERS * PAIRS || d2.counts?.['long-outage'] !== METERS) {
  fail(`isolated: status ${r2.status} ${JSON.stringify(d2.counts)} ${r2.stderr}`);
}
console.log(`smoke: ok --isolated --max-outage 30m in ${ms2} ms: ${METERS * PAIRS} isolated, ${METERS} long outages`);

const t3 = Date.now();
const r3 = run([file]);
if (r3.status !== 1 || !r3.stdout.includes('Findings: 40 (tamper 20, tamper-near-outage 20)')) fail(`text: ${r3.status} ${r3.stderr}`);
console.log(`smoke: ok text report in ${Date.now() - t3} ms`);

const t4 = Date.now();
const r4 = run([file, '--csv', '--isolated', '--max-outage', '30m']);
const csvLines = r4.stdout.trimEnd().split('\n');
const want4 = 1 + 40 + METERS * PAIRS + METERS;
if (r4.status !== 1 || csvLines.length !== want4 || !csvLines[0].startsWith('kind,meter,')) {
  fail(`csv: status ${r4.status} ${csvLines.length} lines (want ${want4}) ${r4.stderr}`);
}
console.log(`smoke: ok --csv in ${Date.now() - t4} ms: ${csvLines.length - 1} finding rows`);

const t5 = Date.now();
const r5 = run([file, '--md']);
if (r5.status !== 1 || !r5.stdout.startsWith('# Meter event check\n') || !r5.stdout.includes('## Findings: 40')) {
  fail(`md: ${r5.status} ${r5.stderr}`);
}
console.log(`smoke: ok --md in ${Date.now() - t5} ms`);

const t6 = Date.now();
const r6 = run([file, '--json', '--max-per-day', 'power=0', '--max-per-day', 'cover=0']);
const ms6 = Date.now() - t6;
const d6 = r6.stdout ? JSON.parse(r6.stdout) : {};
const want6 = powerDays.size + 20;
if (r6.status !== 1 || d6.counts?.['frequency-exceeded'] !== want6 || d6.settings?.maxPerDay?.power !== 0) {
  fail(`max-per-day: status ${r6.status} ${JSON.stringify(d6.counts)} (want ${want6}) ${r6.stderr}`);
}
const r7 = run([file, '--json', '--max-per-day', 'power=1,cover=1']);
const d7 = r7.stdout ? JSON.parse(r7.stdout) : {};
if (r7.status !== 1 || d7.counts?.['frequency-exceeded'] !== undefined) fail(`max-per-day 1: ${JSON.stringify(d7.counts)} ${r7.stderr}`);
console.log(`smoke: ok --max-per-day in ${ms6} ms: ${want6} frequency-exceeded at power=0,cover=0, none at 1`);
