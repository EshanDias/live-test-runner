import * as os from 'os';
import * as path from 'path';

function cacheBaseDir(): string {
  switch (process.platform) {
    case 'darwin': return path.join(os.homedir(), 'Library', 'Caches');
    case 'win32':  return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    default:       return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  }
}

export const LTR_BASE_TMP_DIR   = path.join(os.tmpdir(), 'com.eshLabs', 'live-test-runner');
export const LTR_BASE_CACHE_DIR = path.join(cacheBaseDir(), 'com.eshLabs', 'live-test-runner');
