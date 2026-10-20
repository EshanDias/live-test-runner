const config = require('./config');

test('config has a greeting', () => {
  expect(config.greeting).toBe('hello');
});
