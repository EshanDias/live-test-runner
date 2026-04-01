export class SelectionPolicy {
  static isTestFile(filePath: string, patterns: string[]): boolean {
    // Check if file matches test patterns
    return patterns.some(pattern => {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return regex.test(filePath);
    });
  }

  static getRelatedTests(filePath: string): string[] {
    // Fallback logic for finding related tests
    // For now, simple heuristic: replace .ts with .test.ts etc.
    const base = filePath.replace(/\.(ts|js)$/, '');
    return [`${base}.test.ts`, `${base}.spec.ts`];
  }
}