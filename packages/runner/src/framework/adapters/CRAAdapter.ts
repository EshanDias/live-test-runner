import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { Framework } from "../../types";
import { FrameworkAdapter } from "./FrameworkAdapter";
import { readPackageJson } from "./JestAdapter";

/**
 * Handles Create React App (react-scripts) projects.
 *
 * CRA hides its Jest config internally inside react-scripts. We extract it by running:
 *
 *   node ./node_modules/react-scripts/bin/react-scripts.js test --showConfig --passWithNoTests
 *
 * We then write the extracted config to a temp file and run Jest directly against it.
 * This gives us full ownership of the Jest invocation (--json, --outputFile, etc.)
 * without relying on react-scripts at test-run time.
 *
 * ── In-memory cache ──────────────────────────────────────────────────────────
 * Extracting the config takes ~2-3s. We cache the result keyed by projectRoot + the
 * package.json mtime so we only pay the cost once per session (or when the project's
 * package.json changes).
 */
export class CRAAdapter implements FrameworkAdapter {
  readonly framework: Framework = "cra";

  /** key: projectRoot, value: { configJson, pkgMtime, tmpFilePath } */
  private configCache = new Map<string, CachedConfig>();

  // ── Detection ──────────────────────────────────────────────────────────────

  detect(projectRoot: string): boolean {
    const pkg = readPackageJson(projectRoot);
    if (!pkg) return false;

    const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<
      string,
      string
    >;
    const testScript = (pkg.scripts?.test ?? "") as string;

    return "react-scripts" in deps || testScript.includes("react-scripts test");
  }

  // ── Binary resolution ──────────────────────────────────────────────────────

  /**
   * CRA bundles its own Jest inside react-scripts' node_modules.
   * We prefer that binary because it's guaranteed to be compatible with the
   * extracted config. Falls back to the project's own node_modules/.bin/jest
   * (present in newer CRA versions that list jest as a peer dep).
   */
  resolveJestBinary(projectRoot: string): string {
    // 1. Jest bundled inside react-scripts (most reliable for CRA)
    const craJest = path.join(
      projectRoot,
      "node_modules",
      "react-scripts",
      "node_modules",
      ".bin",
      "jest",
    );
    if (fs.existsSync(craJest) || fs.existsSync(craJest + ".cmd")) {
      return platformCmd(craJest);
    }

    // 2. Project-level jest (newer CRA versions install jest as a peer dep)
    const localJest = path.join(projectRoot, "node_modules", ".bin", "jest");
    if (fs.existsSync(localJest) || fs.existsSync(localJest + ".cmd")) {
      return platformCmd(localJest);
    }

    // 3. jest.js inside react-scripts (fallback if .bin symlink is missing)
    const craJestJs = path.join(
      projectRoot,
      "node_modules",
      "react-scripts",
      "node_modules",
      "jest",
      "bin",
      "jest.js",
    );
    if (fs.existsSync(craJestJs)) {
      return craJestJs; // invoke via `node <path>`
    }

    throw new Error(
      `[CRAAdapter] Cannot locate Jest binary for CRA project at: ${projectRoot}\n` +
        "Ensure react-scripts is installed in node_modules.",
    );
  }

  // ── Config resolution ──────────────────────────────────────────────────────

  /**
   * Extracts the Jest config hidden inside react-scripts and writes it to a
   * deterministic temp file. Returns the path to that file.
   *
   * The temp file is keyed by project root so it is reused across runs.
   * It is invalidated when the project's package.json changes (mtime check).
   */
  async resolveJestConfig(projectRoot: string): Promise<string | undefined> {
    const cached = this.configCache.get(projectRoot);
    const pkgMtime = this.getPackageJsonMtime(projectRoot);

    if (cached && cached.pkgMtime === pkgMtime) {
      // Ensure the temp file still exists (OS may have cleaned /tmp)
      if (fs.existsSync(cached.tmpFilePath)) {
        return cached.tmpFilePath;
      }
    }

    const configJson = this.extractConfigJson(projectRoot);
    const tmpFilePath = this.writeTempConfig(projectRoot, configJson);

    this.configCache.set(projectRoot, { configJson, pkgMtime, tmpFilePath });
    return tmpFilePath;
  }

  getExtraArgs(_projectRoot: string): string[] {
    return [];
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Runs react-scripts via the project's local node_modules to extract the
   * Jest config JSON. Uses synchronous execution because this happens once
   * before the first test run.
   */
  private extractConfigJson(projectRoot: string): string {
    const reactScriptsBin = path.join(
      projectRoot,
      "node_modules",
      "react-scripts",
      "bin",
      "react-scripts.js",
    );

    if (!fs.existsSync(reactScriptsBin)) {
      throw new Error(
        `[CRAAdapter] react-scripts not found at: ${reactScriptsBin}\n` +
          "Run npm install inside your project first.",
      );
    }

    let stdout: string;
    try {
      stdout = execFileSync(
        process.execPath, // node — always available, no global dependency
        [reactScriptsBin, "test", "--showConfig", "--passWithNoTests"],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            NODE_ENV: "test",
            BABEL_ENV: "test",
            CI: "true",
          },
          encoding: "utf8",
          // Cap at 30s — showConfig should be fast; if it hangs something is wrong
          timeout: 30_000,
        },
      );
    } catch (err: any) {
      throw new Error(
        `[CRAAdapter] Failed to extract Jest config from react-scripts:\n${err.message}`,
      );
    }

    return this.parseShowConfigOutput(stdout);
  }

  /**
   * `react-scripts test --showConfig` outputs a JSON blob that looks like:
   *
   *   { "configs": [{ "rootDir": "...", "transform": {...}, ... }], "globalConfig": {...} }
   *
   * We extract configs[0] — the per-project config — and return it as a JSON string
   * suitable for passing to Jest via --config.
   */
  private parseShowConfigOutput(stdout: string): string {
    // The output may have preamble text before the JSON. Find the first '{'.
    const jsonStart = stdout.indexOf("{");
    if (jsonStart === -1) {
      throw new Error("[CRAAdapter] --showConfig produced no JSON output.");
    }

    const raw = JSON.parse(stdout.slice(jsonStart));

    // Jest v27+ wraps results in { configs: [...], globalConfig: {...} }
    const projectConfig = Array.isArray(raw.configs) ? raw.configs[0] : raw;
    if (!projectConfig) {
      throw new Error(
        "[CRAAdapter] --showConfig JSON did not contain a project config.",
      );
    }

    return JSON.stringify(sanitizeJestConfig(projectConfig), null, 2);
  }

  /**
   * Writes the config JSON to a deterministic temp file.
   * Using a stable name (based on project root) means we reuse the same file
   * across sessions until it's invalidated — avoiding accumulation in /tmp.
   */
  private writeTempConfig(projectRoot: string, configJson: string): string {
    const hash = simpleHash(projectRoot);
    const tmpFilePath = path.join(os.tmpdir(), `ltr-cra-config-${hash}.json`);
    fs.writeFileSync(tmpFilePath, configJson, "utf8");
    return tmpFilePath;
  }

  private getPackageJsonMtime(projectRoot: string): number {
    try {
      return fs.statSync(path.join(projectRoot, "package.json")).mtimeMs;
    } catch {
      return 0;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface CachedConfig {
  configJson: string;
  pkgMtime: number;
  tmpFilePath: string;
}

function platformCmd(bin: string): string {
  if (process.platform === "win32") {
    const lower = bin.toLowerCase();
    if (!lower.endsWith(".cmd") && !lower.endsWith(".exe")) return `${bin}.cmd`;
  }
  return bin;
}

/**
 * Keys that appear in --showConfig output but are NOT valid Jest config options.
 * Passing them to Jest causes a "Unknown option" Validation Error.
 */
const INVALID_JEST_CONFIG_KEYS: ReadonlySet<string> = new Set(['cwd', 'name', 'id']);

/**
 * Normalises the raw config object extracted from react-scripts --showConfig:
 *
 * 1. Strips keys that are not valid Jest config options (e.g. `cwd`).
 * 2. Normalises `moduleNameMapper` and `transform` from Jest's internal
 *    array-of-tuples format back to the plain-object format Jest expects
 *    when passed via --config:
 *
 *      [[pattern, replacement], ...]  →  { pattern: replacement, ... }
 */
function sanitizeJestConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (INVALID_JEST_CONFIG_KEYS.has(key)) continue;

    if (key === 'moduleNameMapper' || key === 'transform') {
      result[key] = normalizeTupleMap(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Jest internally serialises mapper/transform as arrays of 2-element tuples.
 * When writing a config file for --config, Jest expects a plain object.
 * Returns the value unchanged if it is already an object (or not an array).
 */
function normalizeTupleMap(value: unknown): unknown {
  if (
    Array.isArray(value) &&
    value.every((item) => Array.isArray(item) && item.length >= 2)
  ) {
    return Object.fromEntries(value.map(([k, v]: [string, unknown]) => [k, v]));
  }
  return value;
}

/** Simple djb2-style hash for stable temp file naming — not cryptographic. */
function simpleHash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}
