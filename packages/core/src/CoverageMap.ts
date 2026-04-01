export class CoverageMap {
  private map: Map<string, Set<string>> = new Map();

  buildFromCoverage(coverageData: any): void {
    // Parse coverage JSON and build the map
    // coverageData is from Jest coverage reporter
    // For each source file, collect test files that cover it
    // This is simplified; in real implementation, parse the coverage report
    // Assuming coverageData has structure like { file: { coveredBy: [tests] } }
    for (const [sourceFile, data] of Object.entries(coverageData)) {
      const tests = (data as any).coveredBy || [];
      this.map.set(sourceFile, new Set(tests));
    }
  }

  getAffectedTests(sourceFile: string): Set<string> {
    return this.map.get(sourceFile) || new Set();
  }

  clear(): void {
    this.map.clear();
  }
}