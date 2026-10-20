/**
 * IProjectConfig — the project's test-runner config, resolved the way the
 * framework itself resolves it, for the instrumented runs to layer their own
 * settings on top of.
 *
 * One implementation per framework (Jest: {@link JestProjectConfig}). The
 * file it points to is in that framework's own format; only the matching
 * batch / instrumented runner reads it.
 */
export interface IProjectConfig {
  /**
   * Path of a file holding the project's resolved config, or undefined when
   * the framework could not report it (callers then fall back to their own
   * config loading). Cached per project root until {@link reset}.
   */
  get(projectRoot: string): Promise<string | undefined>;

  /** Forget cached configs (a new session re-reads them — the config may have changed). */
  reset(): void;
}
