import * as os from 'os';
import * as path from 'path';

/**
 * Root temporary directory for all files written by the Live Test Runner extension.
 * All transient files (raw traces, per-test JSONL, temp Jest configs) are placed
 * inside this folder so cleanup is a single rmSync on the parent.
 *
 * Structure:
 *   LTR_TMP_DIR/
 *     traces-<timestamp>/   ← per-session trace files (one dir per Start Testing)
 *     raw-<ts>-<rand>.jsonl ← short-lived raw JSONL before partitioning
 *     session-cfg-<ts>.js   ← ephemeral Jest config for session trace runs
 *     jest-cfg-<ts>.js      ← ephemeral Jest config for timeline debugger runs
 */
export const LTR_BASE_TMP_DIR = path.join(os.tmpdir(), 'com.eshLabs', 'live-test-runner');
