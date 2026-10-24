import { defineWorkspace } from 'vitest/config';

// Vitest < 3.2 style: a workspace file next to the config. The execution
// trace must reach both projects; *.test-d.ts files are only type-checked.
export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: { name: 'app', include: ['src/**/*.test.ts'], typecheck: { enabled: true, include: ['src/**/*.test-d.ts'] } },
  },
  'packages/*',
]);
