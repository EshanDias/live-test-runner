// Matches the default glob patterns, but vitest.config.mjs `include` leaves it out.
import { test } from 'vitest';
test('never run by Vitest', () => {});
