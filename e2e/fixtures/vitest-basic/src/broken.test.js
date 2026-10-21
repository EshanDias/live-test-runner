// Imports a module that does not exist: Vitest cannot load this file.
import { it } from 'vitest';
import { missing } from './does-not-exist.js';

it('never runs', () => {
  missing();
});
