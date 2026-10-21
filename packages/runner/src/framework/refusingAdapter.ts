import { FrameworkAdapter } from './adapters/FrameworkAdapter';
import { UnsupportedFrameworkError } from './UnsupportedFrameworkError';

/**
 * `adapter` with every run-time method throwing UnsupportedFrameworkError.
 * A runner keeps this for a project of another framework, so setting the
 * project root never fails and the refusal comes when a run starts.
 */
export function refusingAdapter(adapter: FrameworkAdapter): FrameworkAdapter {
  const refuse = (): never => { throw new UnsupportedFrameworkError(adapter.framework); };
  return {
    framework: adapter.framework,
    detect: (root) => adapter.detect(root),
    capabilities: (root) => adapter.capabilities(root),
    resolveBinary: refuse,
    resolveConfig: async () => refuse(),
    getExtraArgs: refuse,
    outputFileArg: refuse,
    parseResult: refuse,
    createRunner: refuse,
  };
}
