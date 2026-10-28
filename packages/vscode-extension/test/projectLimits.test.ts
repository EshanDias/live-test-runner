import { autoMaxRunningProjects, resolveMaxRunningProjects, startRefusal } from '../src/project/projectLimits';

const GB = 1024 ** 3;

describe('maxRunningProjects (D11)', () => {
  it('auto: 2 by default, 1 with ≤ 4 cores or < 8 GB total memory', () => {
    expect(autoMaxRunningProjects(8, 8 * GB)).toBe(2);
    expect(autoMaxRunningProjects(12, 16 * GB)).toBe(2);
    expect(autoMaxRunningProjects(4, 32 * GB)).toBe(1);
    expect(autoMaxRunningProjects(16, 7.9 * GB)).toBe(1);
  });

  it('numbers win over auto; anything else is auto', () => {
    expect(resolveMaxRunningProjects(3, 2, 1 * GB)).toBe(3);
    expect(resolveMaxRunningProjects(undefined, 8, 4 * GB)).toBe(1);
    expect(resolveMaxRunningProjects('4', 2, 1 * GB)).toBe(4);
    expect(resolveMaxRunningProjects('auto', 8, 8 * GB)).toBe(2);
    expect(resolveMaxRunningProjects(0, 8, 8 * GB)).toBe(2);
    expect(resolveMaxRunningProjects(undefined, 2, 8 * GB)).toBe(1);
    expect(resolveMaxRunningProjects(2.7, 8, 8 * GB)).toBe(2);
  });

  it('refuses a start at the limit and names the running projects', () => {
    expect(startRefusal([], 1)).toBeUndefined();
    expect(startRefusal(['web'], 2)).toBeUndefined();
    const msg = startRefusal(['web', 'api'], 2);
    expect(msg).toMatch(/^Stop a running project first/);
    expect(msg).toContain('"web", "api" are running');
    expect(startRefusal(['web'], 1)).toContain('"web" is running');
  });
});
