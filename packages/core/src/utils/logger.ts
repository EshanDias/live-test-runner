/**
 * logger.ts — core reuses the runner's pluggable logger so both packages share
 * one sink (installed by the extension at activation).
 */
export { createLogger } from '@live-test-runner/runner';
