import { money } from './format';

test('formats cents', () => {
  console.log('formatting money');
  expect(money(1234)).toBe('$12.34');
});
