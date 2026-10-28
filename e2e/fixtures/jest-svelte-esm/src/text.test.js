import { shout } from './text.js';

test('shouts', () => {
  expect(shout('a')).toBe('A');
});
