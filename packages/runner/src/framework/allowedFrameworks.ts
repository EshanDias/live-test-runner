/**
 * Roots where a runner may run although detection picked the other framework
 * (mixed-framework projects, phase 8). No imports from the adapters, so the
 * runners can use it without an import cycle.
 */
import * as path from 'path';

/** The framework families a test file can run with (`jest` covers Create React App). */
export type RoutedFramework = 'jest' | 'vitest';

const allowed = new Set<string>();

function allowKey(root: string, framework: RoutedFramework): string {
  const r = path.resolve(root);
  return `${framework}\0${process.platform === 'win32' ? r.toLowerCase() : r}`;
}

/**
 * Lets the `framework` runner run in `root` although detection picked the
 * other framework (a mixed project, or a `liveTestRunner.frameworks` rule).
 * Without it each runner refuses a root of the other framework (BUG-37).
 */
export function allowFrameworkAt(root: string, framework: RoutedFramework, allow = true): void {
  if (allow) { allowed.add(allowKey(root, framework)); } else { allowed.delete(allowKey(root, framework)); }
}

/** Whether {@link allowFrameworkAt} allowed `framework` in `root`. */
export function isFrameworkAllowedAt(root: string, framework: RoutedFramework): boolean {
  return allowed.has(allowKey(root, framework));
}
