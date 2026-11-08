#!/usr/bin/env node
'use strict';
/**
 * Fails when a dependency has a known vulnerability above our bar:
 *
 * - code that ships in the extension (scripts/shipped-packages.js): any advisory;
 * - everything else (dev tooling: build, lint, tests): high or critical.
 *
 * Low and moderate advisories in dev tooling are listed, not failed: they only
 * see our own files and config. Source: `pnpm audit` (the npm advisory
 * database, i.e. GitHub's). To accept an advisory that has no fix, add its
 * GHSA id to `auditConfig.ignoreGhsas` in pnpm-workspace.yaml with a comment
 * saying why and when to look again.
 *
 *   node scripts/security-audit.js
 */
const { spawnSync } = require('child_process');
const SHIPPED = require('./shipped-packages');

const FAIL_AT = new Set(['high', 'critical']);

const res = spawnSync('pnpm', ['audit', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
let report;
try { report = JSON.parse(res.stdout); } catch {
  console.error(`pnpm audit gave no report (exit ${res.status}):\n${res.stderr || res.stdout}`);
  process.exit(2);
}
if (report.error) { console.error(`pnpm audit: ${report.error.summary || JSON.stringify(report.error)}`); process.exit(2); }

const failures = [];
const listed = [];
for (const a of Object.values(report.advisories || {})) {
  const paths = [...new Set((a.findings || []).flatMap((f) => f.paths))];
  const versions = [...new Set((a.findings || []).map((f) => f.version))].join(', ');
  const line = `${a.severity} ${a.module_name}@${versions}: ${a.title} (${a.github_advisory_id || a.url}; fixed in ${a.patched_versions || 'no version yet'})`;
  const shipped = Object.prototype.hasOwnProperty.call(SHIPPED, a.module_name);
  if (shipped) { failures.push(`${line} — ships in the extension`); }
  else if (FAIL_AT.has(a.severity)) { failures.push(`${line} — via ${paths[0]}`); }
  else { listed.push(line); }
}

for (const l of listed) { console.log(`allowed (dev tooling, below high): ${l}`); }
for (const f of failures) { console.error(`error: ${f}`); }
console.log(failures.length
  ? `${failures.length} advisory(ies) above the bar. Update the package, add an override in pnpm-workspace.yaml, or accept it in auditConfig.ignoreGhsas with a reason.`
  : `ok: nothing shipped has an advisory, no high or critical in dev tooling (${listed.length} lower listed).`);
process.exitCode = failures.length ? 1 : 0;
