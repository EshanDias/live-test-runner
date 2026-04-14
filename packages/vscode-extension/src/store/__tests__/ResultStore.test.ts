import { ResultStore } from '../ResultStore';

describe('ResultStore', () => {
  let store: ResultStore;

  beforeEach(() => {
    store = new ResultStore();
  });

  describe('nodeResult', () => {
    it('should correctly store the isSnapshot flag on a node', () => {
      const fileId = 'test.js';
      const nodeId = 'test.js:test1';
      
      // Setup file and node first
      store.fileDiscovered(fileId, fileId, 'test.js');
      store.nodeDiscovered(
        fileId,
        nodeId,
        null,
        'test',
        'test1',
        'test1',
        1
      );

      // Apply result with snapshot flag
      store.nodeResult(nodeId, 'failed', 10, ['Snap error'], true);

      const node = store.getNode(nodeId);
      expect(node).toBeDefined();
      expect(node?.status).toBe('failed');
      expect(node?.isSnapshot).toBe(true);
    });

    it('should default isSnapshot to undefined if not provided', () => {
      const fileId = 'test.js';
      const nodeId = 'test.js:test1';
      
      store.fileDiscovered(fileId, fileId, 'test.js');
      store.nodeDiscovered(
        fileId,
        nodeId,
        null,
        'test',
        'test1',
        'test1',
        1
      );

      store.nodeResult(nodeId, 'passed', 5, []);

      const node = store.getNode(nodeId);
      expect(node?.isSnapshot).toBeUndefined();
    });
  });
});
