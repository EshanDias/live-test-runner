const template = require('./greeting.html');

test('loads the html template', () => {
  expect(template).toContain('Hello');
});
