// Re-export from the runner package so there is exactly one definition of these paths.
// All extension code should import from here; runner code imports from '@live-test-runner/runner'.
export { LTR_BASE_TMP_DIR, LTR_BASE_CACHE_DIR } from '@live-test-runner/runner';
