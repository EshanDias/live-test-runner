import { JestAdapter } from '../JestAdapter';

describe('JestAdapter', () => {
  let adapter: JestAdapter;

  beforeEach(() => {
    adapter = new JestAdapter('/tmp/test-results');
  });

  describe('isSnapshotError', () => {
    it('should detect standard Jest snapshot mismatches', () => {
      const msg = `
Error: expect(received).toMatchSnapshot()

Snapshot name: \x60snapshot demo 1\x60

- Snapshot  - 1
+ Received  + 1

  {
-   "a": 1,
+   "a": 2,
  }
      `.trim();
      expect(adapter.isSnapshotError(msg)).toBe(true);
    });

    it('should detect snapshot mismatch even without the name line', () => {
      const msg = `
- Snapshot  - 1
+ Received  + 1
      `.trim();
      expect(adapter.isSnapshotError(msg)).toBe(true);
    });

    it('should NOT detect generic errors as snapshot mismatches', () => {
      const msg = 'Error: expected 1 to be 2';
      expect(adapter.isSnapshotError(msg)).toBe(false);
    });

    it('should NOT detect console logs as snapshot mismatches', () => {
      const msg = 'Some log with - Snapshot in it but not the Received pair';
      expect(adapter.isSnapshotError(msg)).toBe(false);
    });
  });
});
