const { greet } = require('./greet');

test('greets', () => { expect(greet('Ada')).toBe('Hello, Ada!'); });
test('greets the empty name', () => { expect(greet('')).toBe('Hello, !'); });
test('greets with spaces', () => { expect(greet('A B')).toBe('Hello, A B!'); });
