import * as vscode from 'vscode';
import * as fs from 'fs';
import { ExecutionTraceStore } from '../store/ExecutionTraceStore';
import { ResultStore } from '../store/ResultStore';
import { CoverageStore } from '../coverage/CoverageStore';
import { Manifest } from '../coverage/types';

const BRANCH_TYPE_LABEL: Record<string, string> = {
  IfStatement:               'if/else',
  ConditionalExpression:     '? : ternary',
  LogicalExpression:         '&& / ||',
  OptionalMemberExpression:  '?. optional chain',
  OptionalCallExpression:    '?. optional call',
  SwitchStatement:           'switch',
  NullishCoalescing:         '?? nullish',
};

const MAX_TESTS_SHOWN = 5;

export class CoverageHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly _traceStore: ExecutionTraceStore,
    private readonly _resultStore: ResultStore,
    private readonly _coverageStore: CoverageStore,
  ) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const filePath = document.uri.fsPath;
    const line = position.line + 1; // VS Code is 0-indexed; our stores are 1-based

    const entry = this._coverageStore.getEntry(filePath);
    if (!entry) { return undefined; }

    if (entry.state === 'measured-stale') {
      const md = new vscode.MarkdownString('$(warning) **Coverage data is stale** — save the file to rerun', true);
      md.supportThemeIcons = true;
      return new vscode.Hover(md);
    }

    if (entry.state !== 'measured') { return undefined; }

    const manifest = _readManifest(entry.manifestPath);
    const traceLines = this._traceStore.getCoveredLines(filePath);
    const isLineCovered = traceLines.has(line);

    // Fallback: trace store may be empty (e.g. Jest exited before flushing trace).
    // Check Istanbul counters so a green bar never shows "not covered" in the hover.
    const isCounterCovered = !isLineCovered && manifest
      ? Object.entries(manifest.statements).some(([id, loc]) => loc.start.line === line && (entry.counters.s[id] ?? 0) > 0)
      : false;

    // ── Partial branch analysis ────────────────────────────────────────────────
    const missedBranches = manifest ? _getMissedBranchesForLine(manifest, entry.counters, line) : [];
    const isPartial = isLineCovered && missedBranches.length > 0;

    if (!isLineCovered) {
      if (isCounterCovered) {
        const md = new vscode.MarkdownString('$(pass) **Covered** — trace data unavailable for this run', true);
        md.supportThemeIcons = true;
        return new vscode.Hover(md);
      }
      const md = new vscode.MarkdownString('$(circle-slash) **Not covered** — no test executed this line', true);
      md.supportThemeIcons = true;
      return new vscode.Hover(md);
    }

    const tests = this._traceStore.getTestsForLine(filePath, line);
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportThemeIcons = true;

    // ── Partial branch detail ──────────────────────────────────────────────────
    if (isPartial) {
      md.appendMarkdown('$(warning) **Partial branch coverage**\n\n');
      for (const b of missedBranches) {
        const label = BRANCH_TYPE_LABEL[b.type] ?? b.type;
        const arms = b.arms.map((a) => `${a.hit ? '$(check)' : '$(x)'}\u00a0${a.label}`).join('\u2002');
        md.appendMarkdown(`&nbsp;&nbsp;\`${label}\`\u2003${arms}\n\n`);
      }
      md.appendMarkdown('\n---\n\n');
    }

    // ── Test list ──────────────────────────────────────────────────────────────
    const icon = isPartial ? '$(circle-filled)' : '$(pass-filled)';
    md.appendMarkdown(`${icon} **Covered by ${tests.length} test${tests.length !== 1 ? 's' : ''}**\n\n`);

    const shown = tests.slice(0, MAX_TESTS_SHOWN);
    for (const { testFileId, fullName } of shown) {
      const node = this._resultStore.findNodeByFullName(testFileId, fullName);
      const status = node?.status ?? 'pending';
      const statusIcon = status === 'passed' ? '$(testing-passed-icon)' : status === 'failed' ? '$(testing-failed-icon)' : '$(testing-queued-icon)';
      const duration = node?.duration != null ? ` \u2002$(clock) ${node.duration}ms` : '';

      // Encode args as URI component for the command link
      const args = encodeURIComponent(JSON.stringify({ testFileId, fullName }));
      const revealLink = `[${_escapeMarkdown(fullName)}](command:liveTestRunner.revealTestInPanel?${args})`;
      const openLink = `[$(go-to-file)](command:liveTestRunner.openTestFile?${args} "Open test file")`;

      md.appendMarkdown(`${statusIcon}\u00a0${revealLink}\u2002${openLink}${duration}\n\n`);
    }

    if (tests.length > MAX_TESTS_SHOWN) {
      const args = encodeURIComponent(JSON.stringify({ filePath, line }));
      md.appendMarkdown(`_…and ${tests.length - MAX_TESTS_SHOWN} more_ \u2002[Show all ${tests.length}](command:liveTestRunner.showCoveringTests?${args} "Open Quick Pick with all covering tests")`);
    }

    return new vscode.Hover(md);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

interface MissedBranch {
  type: string;
  arms: Array<{ label: string; hit: boolean }>;
}

function _getMissedBranchesForLine(
  manifest: Manifest,
  counters: { b: Record<string, number[]> },
  line: number,
): MissedBranch[] {
  const result: MissedBranch[] = [];
  for (const [id, branchMeta] of Object.entries(manifest.branches)) {
    if (branchMeta.line !== line) { continue; }
    const hits = counters.b[id];
    if (!hits) { continue; }
    const allHit = hits.every((h) => h > 0);
    if (allHit) { continue; }

    const arms = hits.map((h, i) => ({
      label: _armLabel(branchMeta.type, i, branchMeta.arms),
      hit: h > 0,
    }));
    result.push({ type: branchMeta.type, arms });
  }
  return result;
}

function _armLabel(type: string, index: number, totalArms: number): string {
  if (type === 'IfStatement') {
    return index === 0 ? 'then' : 'else';
  }
  if (type === 'ConditionalExpression') {
    return index === 0 ? 'truthy' : 'falsy';
  }
  if (type === 'LogicalExpression') {
    return index === 0 ? 'left (short-circuit)' : 'right';
  }
  if (type === 'OptionalMemberExpression' || type === 'OptionalCallExpression') {
    return index === 0 ? 'non-null' : 'null/undefined';
  }
  if (type === 'NullishCoalescing') {
    return index === 0 ? 'non-null' : 'null/undefined fallback';
  }
  return totalArms === 2 ? (index === 0 ? 'arm 1' : 'arm 2') : `arm ${index + 1}`;
}

const _manifestCache = new Map<string, Manifest>();

function _readManifest(manifestPath: string): Manifest | undefined {
  const cached = _manifestCache.get(manifestPath);
  if (cached) { return cached; }
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
    _manifestCache.set(manifestPath, data);
    return data;
  } catch {
    return undefined;
  }
}

function _escapeMarkdown(s: string): string {
  return s.replace(/[[\]()\\`*_{}#+.!|]/g, '\\$&');
}
