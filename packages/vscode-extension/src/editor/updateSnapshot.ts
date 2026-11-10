import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import type { ResultStore } from '../store/ResultStore';
import { parseFailure, snapshotKind } from './failureInfo';
import { linesIn, samePath } from './FailureDecorations';

const log = logger.scope('Snapshots');

/** The e2e suite answers the dialog (and sees its text); never set outside a test run. */
let e2eAnswer: ((message: string, detail: string) => boolean) | undefined;
export function setSnapshotDialogAnswerForE2E(answer: typeof e2eAnswer): void { e2eAnswer = answer; }

/** The rerun that rewrites the snapshot: the session's scoped run with the framework's update flag. */
export type SnapshotRerun = (args: { scope: string; fileId: string; nodeId: string; fullName: string; updateSnapshots: true }) => Promise<void>;

/**
 * Update snapshot: the only action that changes a file of the user's project,
 * so it never happens without a yes. A modal dialog names the file that will
 * change; then the test runs once more with the framework's own update flag
 * (Jest `-u`, Vitest `--update`), scoped to this test, so the framework writes
 * the snapshot and every other snapshot stays as it is.
 *
 * @returns true when the snapshot was updated (the rerun ran).
 */
export async function updateSnapshot(store: ResultStore, testFile: string, nodeId: string, rerun: SnapshotRerun, framework: string, projectRoot?: string): Promise<boolean> {
  const node = store.getNode(nodeId);
  if (!node || node.status !== 'failed') { return false; }
  const kind = isInline(node.failureMessages, testFile) ? 'inline' : 'file';

  // The file that will change, as the user knows it.
  const defaultSnap = path.join(path.dirname(testFile), '__snapshots__', `${path.basename(testFile)}.snap`);
  const target = kind === 'inline' ? testFile : defaultSnap;
  const shown = projectRoot ? path.relative(projectRoot, target) || target : target;

  // Unsaved edits there would clash with the framework writing the file.
  const dirty = vscode.workspace.textDocuments.find((d) => d.isDirty && samePath(d.uri.fsPath, target));
  if (dirty) {
    void vscode.window.showWarningMessage(`Save ${path.basename(target)} first: updating the snapshot rewrites that file.`);
    return false;
  }

  const what = kind === 'inline'
    ? `the inline snapshot in ${shown} (the test file itself)`
    : fs.existsSync(defaultSnap) ? shown : 'this test\'s snapshot file';
  const message = `Update the snapshot of "${node.fullName}"?`;
  const detail = kind === 'inline'
    ? `This changes a file in your project: ${framework} rewrites ${what} with what the test produces now. Only this test's snapshot changes. Review the change before you commit it.`
    : `This changes a file in your project: ${framework} rewrites ${what} with what the test produces now. Only this test's snapshot changes; snapshots in that file that no test uses any more are removed, as \`${framework === 'Jest' ? 'jest' : 'vitest'} -u\` does. Review the change before you commit it.`;
  const yes = e2eAnswer
    ? e2eAnswer(message, detail)
    : await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Update Snapshot') === 'Update Snapshot';
  if (!yes) { return false; }

  log.info(`Updating the snapshot of "${node.fullName}" in ${path.basename(testFile)} (confirmed)`);
  await rerun({ scope: node.type, fileId: testFile, nodeId, fullName: node.fullName, updateSnapshots: true });
  return true;
}

/**
 * An inline snapshot lives in the test file. Jest says so in its message
 * (`toMatchInlineSnapshot`); Vitest does not, so the failing line of the test
 * is read too.
 */
function isInline(messages: string[], testFile: string): boolean {
  if (messages.some((m) => snapshotKind(m) === 'inline')) { return true; }
  // The saved file: the failure's line numbers are those of the run, not of unsaved edits.
  let text = '';
  try { text = fs.readFileSync(testFile, 'utf8'); } catch { /* gone */ }
  const lines = text.split(/\r?\n/);
  return messages.some((m) => linesIn(parseFailure(m).frames, testFile, testFile)
    .some((line) => /\bto(?:Match|ThrowErrorMatching)InlineSnapshot\s*\(/.test(lines[line - 1] ?? '')));
}
