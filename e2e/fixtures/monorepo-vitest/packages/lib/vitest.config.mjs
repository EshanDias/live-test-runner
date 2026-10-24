// Two Vitest projects in one config (D12): one switcher entry, files grouped by project name.
export default {
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.js'] } },
      { test: { name: 'integration', include: ['test/**/*.test.js'] } },
    ],
  },
};
