import type { Config } from 'jest';

// The @lib alias exists only here: if this config is not loaded, every test
// fails with "Cannot find module '@lib/…'".
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@lib/(.*)$': '<rootDir>/src/lib/$1',
  },
};

export default config;
