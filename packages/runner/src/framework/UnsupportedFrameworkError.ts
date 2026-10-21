/** Thrown when a project's framework is detected but cannot be run (yet) by the caller. */
export class UnsupportedFrameworkError extends Error {
  constructor(framework: string) {
    super(
      `[Live Test Runner] The "${framework}" framework is not yet supported.\n` +
      'Only Jest and CRA (react-scripts) projects are supported in this version.\n' +
      'Follow https://github.com/EshanDias/live-test-runner for updates.',
    );
    this.name = 'UnsupportedFrameworkError';
  }
}
