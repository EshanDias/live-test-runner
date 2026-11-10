import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let fallback: string | undefined;

/**
 * Where a runner writes its temporary files when it was given no session
 * folder: a private folder of its own (mkdtemp, owner-only), created once per
 * process — never loose, predictable names in the shared temp root.
 */
export function privateTempDir(): string {
  if (!fallback || !fs.existsSync(fallback)) {
    fallback = fs.mkdtempSync(path.join(os.tmpdir(), 'ltr-'));
  }
  return fallback;
}
