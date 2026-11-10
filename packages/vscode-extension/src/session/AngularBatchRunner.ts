import * as path from 'path';
import { angularProjectOf, readAngularWorkspace } from '@live-test-runner/runner';
import { BatchRunOptions, IBatchRunner, RelatedRunOptions } from './IBatchRunner';
import { VitestBatchRunner } from './VitestBatchRunner';
import { testFilesImporting } from './jsImporters';
import { logger } from '../utils/logger';

const log = logger.scope('Angular');

const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/i;

/**
 * Batches for Angular's unit-test builder. One `ng test` runs one Angular
 * project, so a batch is split by project and each part runs through the
 * Vitest batch runner (live results, our reporter's events, coverage — the
 * builder runs Vitest). The builder has no related run: a saved source file
 * reruns the test files that import it (relative imports, followed through
 * other files), or every test of its project when that cannot be told.
 */
export class AngularBatchRunner implements IBatchRunner {
  constructor(private readonly _vitest: VitestBatchRunner) {}

  async runFiles(options: BatchRunOptions): Promise<{ missing: string[]; retry?: string }> {
    const ws = readAngularWorkspace(options.projectRoot);
    const groups = new Map<string, string[]>();
    for (const fp of options.filePaths) {
      const name = (ws && angularProjectOf(ws, fp)?.name) ?? '';
      groups.set(name, [...(groups.get(name) ?? []), fp]);
    }
    const missing: string[] = [];
    for (const files of groups.values()) {
      const r = await this._vitest.runFiles({ ...options, filePaths: files });
      missing.push(...r.missing);
    }
    return { missing };
  }

  async runRelated(options: RelatedRunOptions): Promise<{ ran: string[]; missing: string[] }> {
    const ws = readAngularWorkspace(options.projectRoot);
    const folders = ws ? [...new Set(ws.projects.map((p) => p.sourceRoot))] : [options.projectRoot];
    const known = options.store.getAllFiles().map((f) => f.fileId);
    const files = new Set<string>();
    for (const src of options.sourceFiles) {
      const found = testFilesImporting(src, folders, (f) => TEST_FILE.test(f));
      if (found) {
        log.debug(`${path.basename(src)}: ${found.length} test file(s) import it`);
        // The store's own spelling of each file (realpath / case).
        for (const f of found) { files.add(known.find((k) => path.resolve(k) === f) ?? f); }
        continue;
      }
      // Imported through an alias, or not at all: every test of its project.
      const project = ws ? angularProjectOf(ws, src) : undefined;
      const scope = project?.sourceRoot ?? options.projectRoot;
      const all = known.filter((f) => !path.relative(scope, f).startsWith('..'));
      log.debug(`${path.basename(src)}: no relative import of it found — rerunning the ${all.length} test file(s) of ${project?.name ?? 'the project'}`);
      for (const f of all) { files.add(f); }
    }
    if (files.size === 0) { return { ran: [], missing: [] }; }
    const filePaths = [...files];
    const { missing } = await this.runFiles({ ...options, filePaths });
    return { ran: filePaths, missing };
  }

  kill(): void { this._vitest.kill(); }

  reset(): void { this._vitest.reset(); }
}
