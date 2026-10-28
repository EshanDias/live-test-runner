import { shout } from './text';

test('shouts', () => {
  expect(shout('a')).toBe('A');
});
