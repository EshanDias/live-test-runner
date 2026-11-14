# CLAUDE.md

Guidance for Claude Code in this repo. Details live in `docs/` (the wiki source); this file holds only the rules.

## Commands

```bash
pnpm install | start (watch, then F5) | build | rebuild | lint
pnpm test                          # unit tests (runner + extension)
node e2e/run.js --all              # e2e: real VS Code + real Jest/Vitest/pytest (build first); or name scenarios
node e2e/real-repos.js             # real-repo matrix (repos from gitignored e2e/real-repos.local.json; --all = heavy ones)
python -m pytest packages/runner/python-tests   # shipped pytest plugin tests
node scripts/support-floor.js      # min VS Code / Node check (--update refreshes support-floor.json)
node scripts/security-audit.js     # no known vulns in shipped code, none high/critical anywhere
node scripts/build-wiki.js --check # docs links (fails PRs)
```
Per package: `cd packages/<core|runner> && pnpm run build`, `cd packages/vscode-extension && pnpm run compile`.

## Architecture

Monorepo, strict dependency direction: `vscode-extension` → `core` → `runner`. runner/core never import VS Code; no cycles.
- `runner` — framework-agnostic execution (CommandRunner → per-framework Runner, `FrameworkAdapter`, BinaryResolver, Executor, ResultParser). Adapters: Jest, CRA, Vitest, Angular (Vitest via `ng test`), pytest.
- `core` — `TestSession` (session on/off + its runner).
- `vscode-extension` — UI: `extension.ts` (entry), `session/` (SessionManager, batch runners, trace), `editor/`, `views/`, `store/`, `timeline/` (dormant), `framework/`, `webview/`.

Patterns:
1. **Observers**: results flow one way, `SessionManager` → `IResultObserver`s (`onSessionStart/onRunStart/onFileResult/onSessionStop`). Never pull from the manager. New feature = new observer added in `extension.ts`.
2. **Adapters**: runner `FrameworkAdapter` (binary/config/args/parse) + extension `IFrameworkAdapter` (discovery, debug, classification) + `FrameworkServices` bundle (adapter, projectConfig, batchRunner, instrumentedRunner). `SessionManager` asks `servicesFor(fileOrRoot)`, never builds framework classes. `FrameworkRouter` per project, one factory per routable framework (`ROUTED_FRAMEWORKS`); mixed projects place each test file by setting `liveTestRunner.frameworks` → config lists → imports/calls → main framework. New framework = adapter per package + services bundle; nothing else changes.
3. **Stores**: `ResultStore` is the only place results live (flat `Map<id, TestNode>`, tree by `parentId`; `.each` headers are `template` nodes; LineMap stores identity only, decorations read `getNode()` at render). `ExecutionTraceStore` holds indexes derived from per-test JSONL trace files (`traceIndex`, `coverageIndex`, `sourceToTests`); rebuilt on every reset, trace files are ground truth.
4. **Isolation**: each VS Code window uses `session-<pid>-<timestamp>` temp dir injected via constructors; stale PID dirs pruned on activation. Test runners always run in a spawned child process.
5. **On-save reruns**: after the first full run, a source save reruns tests via the trace, else the framework's related run (`jest --findRelatedTests`, `vitest related`, importing files for pytest). Scoped runs use name patterns (`SessionManager._runAffectedBySourceFile()`).
6. **Session guard**: nothing runs in the background until Start; Stop is final (no batch/retry/fallback after). Explicit clicks (▶ Run, ▷ Debug, rerun) work without a session.
7. **Output attribution**: Jest reports console output per file only; suite/test output exists only when that scope is rerun by name. Vitest attributes each call to its test/suite. Never back-fill: a scope never run shows a placeholder.
8. **Custom webview UI** (not VS Code's Test Results panel: its Mac bug hides test output).

## Rules

1. No circular dependencies; runner/core never depend on VS Code.
2. `spawn()`, never `exec()` (buffer limits).
3. On-save reruns only in an active session.
4. Never back-fill output.
5. Indexes rebuild on reset; trace files are truth.
6. Lazy: results are never pre-fetched; observers are called when ready.
7. Per-scope output: rerun only the requested scope.
8. Log via `logger.scope('Area')` (extension), `createLogger('Area')` (runner/core), `[LTR:<level>] msg` on stderr (in-Jest instrumentation). Never `console.*`, never extension messages in the Test Output channel. ERROR = broken, WARN = degraded, INFO = one line per user action/run, DEBUG/TRACE = detail.
9. **Never touch the user's project**: no installs, no edits to code/config/files; everything ships in the extension, temp files go in the session folder, the user's own terminal runs must keep working. Zero config. Only exception: **Update snapshot**, after a yes in a modal naming the file, with the framework rewriting it (`-u`/`--update` scoped to the test); never add a way around the dialog.
10. **Never overuse the machine**: all parallelism (batches, frameworks, projects, workers) shares one budget from free cores/memory (starts at `liveTestRunner.speed`, default balanced = half the cores, and adapts to what other programs leave free unless `speedStrict`); budget 1 = one at a time; the user's machine stays responsive.
11. **No network, no telemetry**; webviews load nothing remote. AI features only hand data to tools the user runs, on their action (clipboard, VS Code LM tools, local stdio MCP); never call an AI service or open a port. `test/noNetwork.test.ts` enforces it (an allowed module needs a reason). Anything new the extension stores or shares goes in `PRIVACY.md` (bump its date) in the same PR, with a plain explanation for users of what, why, and where it stays. If a feature will need a privacy change, raise it with the owner and agree it at the start, before building; never decide it alone mid-feature.

## Git

**Never work on `main`.** Branch first. Create a branch only for tracked changes (notes in gitignored `dev-personal-docs/` need none). Names start with `release/`, `feat/`, `bugfix/`, `hotfix/`.

| Prefix | From | PR target |
|---|---|---|
| `release/<ver>` | `main` | `main` |
| `feat/*` | `main`, `release/*` or `feat/*` | `release/*` or parent `feat/*` |
| `bugfix/*` | `feat/*`, `release/*`, `main` | the branch it came from (never `main`) |
| `hotfix/*` | `main` | `main` or `release/*` |

- No direct push/merge to `main` or `release/*`; everything lands by PR. `main` accepts only `release/*` and `hotfix/*`; `release/*` accepts `feat/*`, `bugfix/*`, `hotfix/*`, `dependabot/*` (retarget Dependabot PRs).
- PRs fail if `pnpm test` fails; PRs to `main` fail without a version bump (root + `packages/vscode-extension/package.json`) and changelogs.
- Merging to `main` runs `.github/workflows/release.yml` (build, test, publish, then tag + GitHub Release). Never create tags by hand.
- Checks in `.github/workflows/pr-checks.yml`; branch protection setup in the developer guide.

## Docs (the wiki is the source of truth)

**A change is not done until its docs match it, in the same PR.** Each feature has three pages (listed in `docs/README.md`): `docs/features/<f>.md` (plain language), `docs/requirements/<f>.md` (what it must do; each requirement names its tests, ⚠️ = none yet), `docs/development/design/<f>.md` (key files, flow, decisions). Features: test runs, Test Explorer and editor, on-save reruns, Results panel, coverage, debugging, monorepos and mixed frameworks. The GitHub Wiki is generated from `docs/`; never edit it directly. Run `node scripts/build-wiki.js --check`.

| Change | Update |
|---|---|
| New/changed feature | its three pages; new pages listed in `docs/README.md` |
| Architecture / system design | `docs/development/architecture.md`, `ai-context.md` |
| Core or runner API, layers, adapters | package README, `developer-guide.md`, `ai-context.md` |
| Extension feature, UI, command, setting | `packages/vscode-extension/README.md`, `CHANGELOG.md`, `ai-context.md` |
| Dev setup, build, patterns | `developer-guide.md`, this file |
| Anything stored/shared/sent | `PRIVACY.md` with a clear why for users (+ `noNetwork.test.ts` green); discuss with the owner first |
| Any user-visible change | both changelogs, following **Changelogs** below |
| Important for users/contributors | `docs/live-test-runner-guide.html` |
| Headline features, frameworks, install/review links | `site/index.html` (+ `lastmod` in `site/sitemap.xml`), root `README.md` |

**Changelogs: as short as possible** (every release; the more you write, the less anyone reads).
- `packages/vscode-extension/CHANGELOG.md` (what users read in VS Code): only what a user notices, one plain line each, about 3–6 lines per release (a patch often fits in 3). No internals, no file/function/test names, no causes, no measurements beyond a headline speed-up ("pytest runs 2× faster"). Merge related items into one line; leave out fixes for things users never saw.
- `CHANGELOG.md` (repo): one short line per change, a key file or setting name at most; no causes, numbers, test lists or sub-bullets. Tooling/CI only when it changes how contributors work. The how and why go in `docs/development/design/`, the detail in the commits.

**Release prep (last step of every release, before the release PR):** bring all docs to a professional standard, not just the changed lines: features/requirements/design pages, architecture, developer guide (incl. Roadmap: shipped list + next list), guide HTML, website, READMEs, both changelogs, `PRIVACY.md`. Move anything still worth keeping out of `dev-personal-docs/` into the wiki, then delete the plans/notes that are finished or no longer needed. Check `--check` passes and no doc contradicts the code.

**Public repo**: everything committed is public. No personal notes, local paths (`/Users/…`), private project names, or "who decided what"; cite the reason. Working notes live in gitignored `dev-personal-docs/` (`plans/master-tracker.md` = live to-do, holds only open work in priority order). Bugs and ideas are GitHub Issues.

**HTML pages** (`site/index.html`, guide): keep in step with README and changelogs; every external link (and the site's links to the guide) uses `target="_blank" rel="noopener"`; only `#anchors` and the site's home link stay in-tab.

**README.md** (marketplace-facing): short and scannable, bullets/tables, no text a new user doesn't need. A feature needing a GIF/screenshot gets `<!-- [TODO: USER_INPUT_NEEDED] what is needed -->`; use the same placeholder for any other missing user input.

## References
`docs/README.md` (all docs) · `docs/requirements/project-rules.md` (rules + how each is checked) · `docs/development/{architecture,developer-guide,ai-context}.md` · `CONTRIBUTING.md` · `SECURITY.md` · `PRIVACY.md` · package READMEs · `docs/live-test-runner-guide.html` · `site/index.html`
