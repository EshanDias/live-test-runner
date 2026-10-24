/**
 * FrameworkRouter — a project's {@link IFrameworkServicesProvider}: which
 * framework runs each of its test files (phase 8, ADR-8).
 *
 * A single-framework project (every pure Jest / Vitest project, and each
 * package of a monorepo) gets one bundle — the framework detection picks,
 * as before. A mixed project — a Jest root with its own `vitest.config.*`
 * (or `vitest.workspace.*`), or one where `liveTestRunner.frameworks` sends
 * files to the other framework — lists its files with both frameworks and
 * places each file once (runner `assignFrameworks`):
 *
 *  1. `liveTestRunner.frameworks` — the first glob that matches wins;
 *  2. the framework whose own list holds the file;
 *  3. listed by both: an import from `vitest` / a `vi.` call → Vitest,
 *     `@jest/globals` / a `jest.` call → Jest;
 *  4. nothing in the file says → the main framework + one WARN naming the setting (D13).
 *
 * A file's framework then decides everything about its runs: binary,
 * config, flags, batch runner, reporter, coverage.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FrameworkDetector,
  FRAMEWORK_IDS,
  FrameworkId,
  RoutedFramework,
  FrameworkRule,
  allowFrameworkAt,
  assignFrameworks,
  frameworkHint,
  matchFrameworkRule,
  parseFrameworkRules,
  projectFrameworks,
} from '@live-test-runner/runner';
import { FrameworkServices, IFrameworkServicesProvider, RunnableListing, listWith } from './FrameworkServices';
import { runnableKey } from '../session/RunnableFiles';
import { logger } from '../utils/logger';

const log = logger.scope('Framework');

/** Rules whose answer can change when the file's content changes. */
const CONTENT_RULES = new Set(['hint', 'primary']);

/** "a.test.ts, b.test.ts, +3 more" */
function shortList(paths: string[], max = 5): string {
  const names = paths.map((p) => path.basename(p));
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')}, +${names.length - max} more`;
}

function other(fw: RoutedFramework): RoutedFramework {
  return fw === 'jest' ? 'vitest' : 'jest';
}

/** What a test file says it uses (undefined: nothing, or unreadable). */
function readHint(filePath: string): RoutedFramework | undefined {
  try { return frameworkHint(fs.readFileSync(filePath, 'utf8')); } catch { return undefined; }
}

export class FrameworkRouter implements IFrameworkServicesProvider {
  private readonly _bundles = new Map<RoutedFramework, FrameworkServices>();
  private _primary: RoutedFramework | undefined;
  /** Why the root is mixed by its own configs (undefined: it is not). */
  private _mixedByConfig: string | undefined;
  private _rules: FrameworkRule[] = [];
  private _mixed = false;
  /** Mixed projects: file key → its framework and the rule that placed it. */
  private _byFile = new Map<string, { fw: RoutedFramework; rule: string }>();
  /** WARN lines already shown (setting errors, D13 defaults) — once per message. */
  private readonly _warned = new Set<string>();

  constructor(
    private readonly _factories: Record<RoutedFramework, () => FrameworkServices>,
    private readonly _root: string,
    /** The setting's base folder (the workspace folder holding the root). */
    private readonly _settingBase: () => string = () => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(_root))?.uri.fsPath ?? _root,
    /** The `liveTestRunner.frameworks` setting. */
    private readonly _setting: () => unknown = () => vscode.workspace.getConfiguration('liveTestRunner').get('frameworks'),
    private readonly _detector = new FrameworkDetector(),
  ) {}

  // ── IFrameworkServicesProvider ────────────────────────────────────────────

  servicesFor(fileOrRoot: string): FrameworkServices {
    const primary = this._primaryFramework();
    if (!this._mixed || fileOrRoot === this._root) { return this._bundle(primary); }
    return this._bundle(this._frameworkOf(fileOrRoot));
  }

  all(): FrameworkServices[] {
    return [...this._bundles.values()];
  }

  prepare(): void {
    let detected: FrameworkId = FRAMEWORK_IDS.jest;
    try { detected = this._detector.detectFramework(this._root); } catch { /* logged by the detector */ }
    const pf = projectFrameworks(this._root, detected);
    this._primary = pf.primary;
    this._mixedByConfig = pf.mixed ? pf.reason : undefined;
    const { rules, errors } = parseFrameworkRules(this._setting(), this._settingBase());
    this._rules = rules;
    for (const e of errors) { this._warnOnce(e); }
    // Until the listing says otherwise, mixed is what the configs say.
    this._setMixed(!!this._mixedByConfig);
    log.debug(`${this._root}: main framework ${pf.primary} (detected "${detected}"; ${pf.reason})${rules.length ? ` · ${rules.length} liveTestRunner.frameworks rule(s)` : ''}`);
  }

  async listTestFiles(projectRoot: string, discovered: string[], rawLog: (msg: string) => void): Promise<RunnableListing> {
    const primary = this._primaryFramework();
    const second = other(primary);
    const ruleHit = discovered.some((f) => matchFrameworkRule(this._rules, f)?.framework === second);
    this._byFile.clear();
    if (!this._mixedByConfig && !ruleHit) {
      this._setMixed(false);
      return listWith(this._bundle(primary).adapter, projectRoot, rawLog);
    }
    this._setMixed(true);

    const list = async (fw: RoutedFramework): Promise<RunnableListing | undefined> => {
      const services = this._bundle(fw);
      try {
        return await listWith(services.adapter, projectRoot, rawLog);
      } catch (err) {
        log.warn(`Could not ask ${services.terms.name} which files it runs (${services.terms.listCommand}) — it may run any test file of this project`, err);
        return undefined;
      }
    };
    const [first, secondList] = await Promise.all([list(primary), list(second)]);
    const lists: Record<RoutedFramework, RunnableListing | undefined> = { [primary]: first, [second]: secondList } as Record<RoutedFramework, RunnableListing | undefined>;

    const files = [...new Set([...discovered, ...(first?.files ?? []), ...(secondList?.files ?? [])])];
    const out = assignFrameworks({
      files,
      keyOf: runnableKey,
      primary,
      groups: [primary, second].map((fw) => ({ id: fw, framework: fw, files: lists[fw]?.files })),
      ruleFor: (f) => matchFrameworkRule(this._rules, f)?.framework,
      hint: readHint,
    });

    const runnable: string[] = [];
    const frameworks: Record<string, string> = {};
    const counts: Record<RoutedFramework, number> = { jest: 0, vitest: 0 };
    const byKey = new Map(files.map((f) => [runnableKey(f), f]));
    for (const [key, a] of out.assignments) {
      const fw = a.group as RoutedFramework;
      this._byFile.set(key, { fw, rule: a.rule });
      if (!a.runnable) { continue; }
      const file = byKey.get(key)!;
      runnable.push(file);
      frameworks[file] = `${fw}:${a.rule}`;
      counts[fw]++;
    }
    log.info(
      `${path.basename(this._root)}: mixed Jest + Vitest project (${this._mixedByConfig ?? 'liveTestRunner.frameworks'}) — ` +
      `Jest runs ${counts.jest} test file(s), Vitest ${counts.vitest}`,
    );
    if (out.hinted.length > 0) {
      log.debug(`Listed by both frameworks, placed by their imports / calls: ${shortList(out.hinted, 10)}`);
    }
    this._warnDefaulted(out.defaulted);
    if (!first && !secondList) { return { files: [], frameworks }; }
    return { files: runnable, groups: this._groups(runnable, lists), frameworks };
  }

  restore(listing: RunnableListing): void {
    this._byFile.clear();
    const entries = Object.entries(listing.frameworks ?? {});
    if (entries.length === 0) {
      this._setMixed(false);
      return;
    }
    this._setMixed(true);
    const defaulted: string[] = [];
    for (const [file, value] of entries) {
      const [fw, rule = 'ownership'] = value.split(':') as [RoutedFramework, string];
      this._byFile.set(runnableKey(file), { fw, rule });
      // The file may say something new since the list was made.
      if (CONTENT_RULES.has(rule)) {
        const placed = this._reread(file);
        if (placed?.rule === 'primary') { defaulted.push(file); }
      }
    }
    this._warnDefaulted(defaulted);
  }

  fileChanged(filePath: string): void {
    if (!this._mixed) { return; }
    const was = this._byFile.get(runnableKey(filePath));
    if (!was || !CONTENT_RULES.has(was.rule)) { return; }
    const now = this._reread(filePath);
    if (now && now.fw !== was.fw) {
      log.info(`${path.basename(filePath)} now runs with ${now.fw === 'vitest' ? 'Vitest' : 'Jest'} (${now.rule === 'hint' ? 'its imports / calls' : 'nothing in it says — the main framework'})`);
    }
  }

  fingerprint(): string {
    const primary = this._primaryFramework();
    const parts = [this._bundle(primary).settingsFingerprint()];
    if (this._mixedByConfig || this._rules.length > 0) {
      parts.push(this._bundle(other(primary)).settingsFingerprint(), `frameworks=${JSON.stringify(this._setting() ?? null)}`);
    }
    return parts.join('|');
  }

  isMixed(): boolean {
    return this._mixed;
  }

  /** The framework of every file placed by the last listing (for the e2e API / diagnostics). */
  frameworksByFile(): Record<string, RoutedFramework> {
    return Object.fromEntries([...this._byFile].map(([k, v]) => [k, v.fw]));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _primaryFramework(): RoutedFramework {
    if (!this._primary) {
      let detected: FrameworkId = FRAMEWORK_IDS.jest;
      try { detected = this._detector.detectFramework(this._root); } catch { /* logged by the detector */ }
      this._primary = detected === FRAMEWORK_IDS.vitest ? 'vitest' : 'jest';
    }
    return this._primary;
  }

  /** A file the listing did not place (new since, or a source file): the setting, then its hint (test files), else the main framework. */
  private _frameworkOf(filePath: string): RoutedFramework {
    const known = this._byFile.get(runnableKey(filePath));
    if (known) { return known.fw; }
    const rule = matchFrameworkRule(this._rules, filePath);
    if (rule) { return rule.framework; }
    const primary = this._primaryFramework();
    if (!this._bundle(primary).adapter.isTestFile(filePath)) { return primary; }
    return readHint(filePath) ?? primary;
  }

  /** Re-reads the hint of a file both frameworks list. */
  private _reread(filePath: string): { fw: RoutedFramework; rule: string } | undefined {
    const key = runnableKey(filePath);
    if (!this._byFile.has(key)) { return undefined; }
    const hint = readHint(filePath);
    const placed = hint ? { fw: hint, rule: 'hint' } : { fw: this._primaryFramework(), rule: 'primary' };
    this._byFile.set(key, placed);
    return placed;
  }

  private _setMixed(mixed: boolean): void {
    this._mixed = mixed;
    // Each runner refuses a root of the other framework unless allowed here.
    allowFrameworkAt(this._root, other(this._primaryFramework()), mixed);
  }

  /** Explorer groups of a mixed project: the framework, with Vitest's project name when it has several. */
  private _groups(files: string[], lists: Record<RoutedFramework, RunnableListing | undefined>): Record<string, string> | undefined {
    const groups: Record<string, string> = {};
    const used = new Set<RoutedFramework>();
    for (const f of files) {
      const fw = this._byFile.get(runnableKey(f))?.fw ?? this._primaryFramework();
      used.add(fw);
      const name = this._bundle(fw).displayName;
      const sub = lists[fw]?.groups?.[f];
      groups[f] = sub ? `${name} · ${sub}` : name;
    }
    // One framework in use after all: keep that framework's own groups (Vitest projects), else none.
    if (used.size < 2) {
      const only = [...used][0];
      return only ? lists[only]?.groups : undefined;
    }
    return groups;
  }

  private _warnDefaulted(files: string[]): void {
    if (files.length === 0) { return; }
    const name = this._bundle(this._primaryFramework()).displayName;
    this._warnOnce(
      `${files.length} test file(s) match both the Jest and the Vitest config and nothing in them says which they use — ` +
      `running them with ${name} (the project's main framework): ${shortList(files)}. ` +
      `Set liveTestRunner.frameworks to choose, e.g. { "src/**/*.test.ts": "vitest" }, or import from 'vitest' / '@jest/globals' in the file.`,
    );
  }

  private _warnOnce(message: string): void {
    if (this._warned.has(message)) { return; }
    this._warned.add(message);
    log.warn(message);
  }

  private _bundle(fw: RoutedFramework): FrameworkServices {
    let b = this._bundles.get(fw);
    if (!b) {
      b = this._factories[fw]();
      this._bundles.set(fw, b);
    }
    return b;
  }
}
