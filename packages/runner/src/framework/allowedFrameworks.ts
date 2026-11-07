/**
 * Roots where a runner may run although detection picked the other framework
 * (mixed-framework projects). No imports from the adapters, so the
 * runners can use it without an import cycle.
 */
import * as path from 'path';

/**
 * The frameworks a project's router can place a test file with (`jest`
 * covers Create React App). Adding a framework = one entry here, its
 * services bundle in the extension's router factories, and (when a root can
 * hold it next to another framework) its marker in `projectFrameworks`.
 */
export const ROUTED_FRAMEWORKS = ['jest', 'vitest', 'pytest'] as const;
export type RoutedFramework = typeof ROUTED_FRAMEWORKS[number];

const allowed = new Set<string>();

function allowKey(root: string, framework: RoutedFramework): string {
  const r = path.resolve(root);
  return `${framework}\0${process.platform === 'win32' ? r.toLowerCase() : r}`;
}

/**
 * Lets the `framework` runner run in `root` although detection picked
 * another framework (a mixed project, or a `liveTestRunner.frameworks` rule).
 * Without it each runner refuses a root of the other framework (BUG-37).
 */
export function allowFrameworkAt(root: string, framework: RoutedFramework, allow = true): void {
  if (allow) { allowed.add(allowKey(root, framework)); } else { allowed.delete(allowKey(root, framework)); }
}

/** Whether {@link allowFrameworkAt} allowed `framework` in `root`. */
export function isFrameworkAllowedAt(root: string, framework: RoutedFramework): boolean {
  return allowed.has(allowKey(root, framework));
}
