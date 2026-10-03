import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const read = async (path: string) =>
  JSON.parse(
    await readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

describe('what ships', () => {
  // The skill ships in the npm package and in the Claude Code plugin; the two
  // must say they are the same version, or an agent reads instructions for
  // commands its CLI does not have.
  it('gives the plugin the package version, and the skill the frontmatter the Agent Skills spec requires', async () => {
    const pkg = await read('package.json');
    const plugin = await read('.claude-plugin/plugin.json');
    expect(plugin.version).toBe(pkg.version);
    expect(pkg.files).toContain('skills');

    const skill = await readFile(
      new URL('../skills/agentrail/SKILL.md', import.meta.url),
      'utf8',
    );
    const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(skill)?.[1] ?? '';
    const field = (key: string) =>
      new RegExp(`^${key}: (.+)$`, 'mu').exec(frontmatter)?.[1];
    // The name is the skill's folder: lowercase words joined by hyphens.
    expect(field('name')).toBe('agentrail');
    const description = field('description') ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
  });
});
