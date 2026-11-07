/**
 * FrameworkRouter — a project's {@link IFrameworkServicesProvider}: which
 * framework runs each of its test files (phase 8, ADR-8; any number of
 * frameworks since 3.3.0, master tracker A2).
 *
 * A single-framework project (every pure Jest / Vitest / pytest project, and
 * each package of a monorepo) gets one bundle — the framework detection
 * picks, as before. A mixed project — the root configures several
 * frameworks (runner `projectFrameworks`: a Jest root with its own
 * `vitest.config.*` / `vitest.workspace.*`), or `liveTestRunner.frameworks`
 * sends files to another framework — lists its files with every framework in
 * play and places each file once (runner `assignFrameworks`):
 *
 *  1. `liveTestRunner.frameworks` — the first glob that matches wins;
 *  2. the framework whose own list holds the file;
 *  3. listed by several: an import from `vitest` / a `vi.` call → Vitest,
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
  routedFrameworkOf,
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

/** What a test file says it uses (undefined: nothing, or unreadable). */
function readHint(filePath: string): RoutedFramework | undefined {
  try { return frameworkHint(fs.readFileSync(filePath, 'utf8')); } catch { return undefined; }
}

/** The services bundle of each framework a project may run (missing: never in this project). */
export type FrameworkFactories = Partial<Record<RoutedFramework, () => FrameworkServices>>;

export class FrameworkRouter implements IFrameworkServicesProvider {
  private readonly _bundles = new Map<RoutedFramework, FrameworkServices>();
  private _primary: RoutedFramework | undefined;
  /** Every framework the root configures, the primary first (runner `projectFrameworks`). */
  private _configured: RoutedFramework[] = [];
  /** Why the root is mixed by its own configs (undefined: it is not). */
  private _mixedByConfig: string | undefined;
  /** Frameworks other than the primary that the runners currently allow in the root. */
  private _allowed = new Set<RoutedFramework>();
  /** Left out of this session (cannot run now), with why — until the next prepare(). */
  private readonly _disabled = new Map<RoutedFramework, string>();
  private _rules: FrameworkRule[] = [];
  private _mixed = false;
  /** Mixed projects: file key → its framework and the rule that placed it. */
  private _byFile = new Map<string, { fw: RoutedFramework; rule: string }>();
  /** WARN lines already shown (setting errors, D13 defaults) — once per message. */
  private readonly _warned = new Set<string>();

  constructor(
    private readonly _factories: FrameworkFactories,
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

  /** Every bundle in play (built now if needed: Start asks each whether it can run) and any built before. */
  all(): FrameworkServices[] {
    for (const fw of this._inPlay) { this._bundle(fw); }
    return [...this._bundles.values()];
  }

  disable(framework: string, why: string): void {
    const fw = framework as RoutedFramework;
    if (fw === this._primaryFramework() || !this._inPlay.includes(fw)) { return; }
    this._disabled.set(fw, why);
    log.info(`${path.basename(this._root)}: ${this._bundle(fw).displayName} tests are not run this session — ${why}`);
    this._setMixed(this._inPlay.filter((f) => f !== fw));
  }

  prepare(): void {
    this._disabled.clear();
    let detected: FrameworkId = FRAMEWORK_IDS.jest;
    try { detected = this._detector.detectFramework(this._root); } catch { /* logged by the detector */ }
    const pf = projectFrameworks(this._root, detected);
    this._primary = pf.primary;
    this._configured = pf.frameworks.filter((fw) => this._factories[fw]);
    this._mixedByConfig = pf.mixed && this._configured.length > 1 ? pf.reason : undefined;
    const { rules, errors } = parseFrameworkRules(this._setting(), this._settingBase());
    this._rules = rules;
    for (const e of errors) { this._warnOnce(e); }
    // Until the listing says otherwise, mixed is what the configs say.
    this._setMixed(this._mixedByConfig ? this._configured : [pf.primary]);
    log.debug(`${this._root}: main framework ${pf.primary} (detected "${detected}"; ${pf.reason})${rules.length ? ` · ${rules.length} liveTestRunner.frameworks rule(s)` : ''}`);
  }

  async listTestFiles(projectRoot: string, discovered: string[], rawLog: (msg: string) => void): Promise<RunnableListing> {
    const primary = this._primaryFramework();
    // In play: what the root configures, and any framework a setting rule sends a discovered file to.
    const inPlay = this._configuredFrameworks().filter((fw) => !this._disabled.has(fw));
    for (const f of discovered) {
      const fw = matchFrameworkRule(this._rules, f)?.framework;
      if (fw && this._factories[fw] && !this._disabled.has(fw) && !inPlay.includes(fw)) { inPlay.push(fw); }
    }
    this._byFile.clear();
    if (inPlay.length < 2) {
      this._setMixed([primary]);
      return listWith(this._bundle(primary).adapter, projectRoot, rawLog);
    }
    this._setMixed(inPlay);

    const list = async (fw: RoutedFramework): Promise<RunnableListing | undefined> => {
      const services = this._bundle(fw);
      try {
        return await listWith(services.adapter, projectRoot, rawLog);
      } catch (err) {
        log.warn(`Could not ask ${services.terms.name} which files it runs (${services.terms.listCommand}) — it may run any test file of this project`, err);
        return undefined;
      }
    };
    const listings = await Promise.all(inPlay.map(list));
    const lists = new Map(inPlay.map((fw, i) => [fw, listings[i]] as const));

    const files = [...new Set([...discovered, ...listings.flatMap((l) => l?.files ?? [])])];
    const out = assignFrameworks({
      files,
      keyOf: runnableKey,
      primary,
      groups: inPlay.map((fw) => ({ id: fw, framework: fw, files: lists.get(fw)?.files })),
      ruleFor: (f) => matchFrameworkRule(this._rules, f)?.framework,
      hint: readHint,
    });

    const runnable: string[] = [];
    const frameworks: Record<string, string> = {};
    const counts = new Map<RoutedFramework, number>(inPlay.map((fw) => [fw, 0]));
    const byKey = new Map(files.map((f) => [runnableKey(f), f]));
    for (const [key, a] of out.assignments) {
      const fw = a.group as RoutedFramework;
      this._byFile.set(key, { fw, rule: a.rule });
      if (!a.runnable) { continue; }
      const file = byKey.get(key)!;
      runnable.push(file);
      frameworks[file] = `${fw}:${a.rule}`;
      counts.set(fw, (counts.get(fw) ?? 0) + 1);
    }
    const names = inPlay.map((fw) => this._bundle(fw).displayName);
    log.info(
      `${path.basename(this._root)}: mixed ${names.join(' + ')} project (${this._mixedByConfig ?? 'liveTestRunner.frameworks'}) — ` +
      inPlay.map((fw, i) => `${names[i]} ${i === 0 ? 'runs ' : ''}${counts.get(fw) ?? 0}${i === 0 ? ' test file(s)' : ''}`).join(', '),
    );
    if (out.hinted.length > 0) {
      log.debug(`Listed by several frameworks, placed by their imports / calls: ${shortList(out.hinted, 10)}`);
    }
    this._warnDefaulted(out.defaulted);
    if (listings.every((l) => !l)) { return { files: [], frameworks }; }
    return { files: runnable, groups: this._groups(runnable, lists), frameworks };
  }

  restore(listing: RunnableListing): void {
    this._byFile.clear();
    const entries = Object.entries(listing.frameworks ?? {});
    if (entries.length === 0) {
      this._setMixed([this._primaryFramework()]);
      return;
    }
    const inPlay = new Set<RoutedFramework>([this._primaryFramework(), ...this._configuredFrameworks().filter((fw) => !this._disabled.has(fw))]);
    const defaulted: string[] = [];
    const placed: [string, RoutedFramework, string][] = [];
    for (const [file, value] of entries) {
      const [fw, rule = 'ownership'] = value.split(':') as [RoutedFramework, string];
      if (!this._factories[fw] || this._disabled.has(fw)) { continue; } // no longer routed, or left out this session
      inPlay.add(fw);
      placed.push([file, fw, rule]);
    }
    this._setMixed([...inPlay]);
    for (const [file, fw, rule] of placed) {
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
      log.info(`${path.basename(filePath)} now runs with ${this._bundle(now.fw).displayName} (${now.rule === 'hint' ? 'its imports / calls' : 'nothing in it says — the main framework'})`);
    }
  }

  fingerprint(): string {
    const primary = this._primaryFramework();
    const parts = [this._bundle(primary).settingsFingerprint()];
    if (this._mixedByConfig || this._rules.length > 0) {
      const others = new Set<RoutedFramework>([...this._configuredFrameworks(), ...this._rules.map((r) => r.framework)]);
      others.delete(primary);
      for (const fw of others) {
        if (this._factories[fw]) { parts.push(this._bundle(fw).settingsFingerprint()); }
      }
      parts.push(`frameworks=${JSON.stringify(this._setting() ?? null)}`);
    }
    return parts.join('|');
  }

  isMixed(): boolean {
    return this._mixed;
  }

  frameworks(): string[] {
    return this._mixed ? [...this._inPlay] : [this._primaryFramework()];
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
      this._primary = routedFrameworkOf(detected);
    }
    return this._primary;
  }

  /** What the root configures (the primary first); before {@link prepare}: the primary. */
  private _configuredFrameworks(): RoutedFramework[] {
    return this._configured.length > 0 ? this._configured : [this._primaryFramework()];
  }

  /**
   * A file the listing did not place (new since, or a source file): the
   * setting; else the frameworks in play whose test-file rules take it — one
   * is the answer, several are settled by the file's hint, then the main
   * framework; none (a source file) → the main framework.
   */
  private _frameworkOf(filePath: string): RoutedFramework {
    const known = this._byFile.get(runnableKey(filePath));
    if (known) { return known.fw; }
    const rule = matchFrameworkRule(this._rules, filePath);
    if (rule && this._factories[rule.framework]) { return rule.framework; }
    const primary = this._primaryFramework();
    const takers = [...this._inPlay].filter((fw) => this._bundle(fw).adapter.isTestFile(filePath));
    if (takers.length === 0) { return primary; }
    if (takers.length === 1) { return takers[0]; }
    const hint = readHint(filePath);
    if (hint && takers.includes(hint)) { return hint; }
    return takers.includes(primary) ? primary : takers[0];
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

  /** The frameworks the project runs files with now (the primary first). */
  private _inPlay: RoutedFramework[] = [];

  private _setMixed(inPlay: RoutedFramework[]): void {
    const primary = this._primaryFramework();
    this._inPlay = [primary, ...inPlay.filter((fw) => fw !== primary)];
    this._mixed = this._inPlay.length > 1;
    // Each runner refuses a root of another framework unless allowed here.
    const allow = new Set(this._inPlay.slice(1));
    for (const fw of this._allowed) {
      if (!allow.has(fw)) { allowFrameworkAt(this._root, fw, false); }
    }
    for (const fw of allow) { allowFrameworkAt(this._root, fw, true); }
    this._allowed = allow;
  }

  /** Explorer groups of a mixed project: the framework, with Vitest's project name when it has several. */
  private _groups(files: string[], lists: Map<RoutedFramework, RunnableListing | undefined>): Record<string, string> | undefined {
    const groups: Record<string, string> = {};
    const used = new Set<RoutedFramework>();
    for (const f of files) {
      const fw = this._byFile.get(runnableKey(f))?.fw ?? this._primaryFramework();
      used.add(fw);
      const name = this._bundle(fw).displayName;
      const sub = lists.get(fw)?.groups?.[f];
      groups[f] = sub ? `${name} · ${sub}` : name;
    }
    // One framework in use after all: keep that framework's own groups (Vitest projects), else none.
    if (used.size < 2) {
      const only = [...used][0];
      return only ? lists.get(only)?.groups : undefined;
    }
    return groups;
  }

  private _warnDefaulted(files: string[]): void {
    if (files.length === 0) { return; }
    const name = this._bundle(this._primaryFramework()).displayName;
    const names = this._inPlay.map((fw) => `the ${this._bundle(fw).displayName}`);
    const which = names.length > 2 ? `several of ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} configs` : `both ${names.join(' and ')} config`;
    this._warnOnce(
      `${files.length} test file(s) match ${which} and nothing in them says which they use — ` +
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
      const factory = this._factories[fw];
      if (!factory) { throw new Error(`No ${fw} services for ${this._root}`); }
      b = factory();
      this._bundles.set(fw, b);
    }
    return b;
  }
}
