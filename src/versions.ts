/**
 * Semantic versions as this package uses them: `1.2.3` or `1.2.3-dev.4`.
 * A release outranks its pre-releases; pre-release parts compare one by one,
 * numbers numerically.
 */
function parse(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(version);
  if (!match) return undefined;
  const [, major, minor, patch, pre] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    pre: pre === undefined ? [] : pre.split('.'),
  };
}

function compareParts(left: string, right: string): number {
  const leftNumber = /^\d+$/u.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/u.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right);
}

/** Whether `candidate` is newer than `installed`; false when either is not a version. */
export function isNewer(candidate: string, installed: string): boolean {
  const next = parse(candidate);
  const current = parse(installed);
  if (!next || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (next.core[index] ?? 0) - (current.core[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  if (next.pre.length === 0 || current.pre.length === 0) {
    return next.pre.length === 0 && current.pre.length > 0;
  }
  for (
    let index = 0;
    index < Math.max(next.pre.length, current.pre.length);
    index += 1
  ) {
    const left = next.pre[index];
    const right = current.pre[index];
    if (left === undefined) return false;
    if (right === undefined) return true;
    const difference = compareParts(left, right);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** The npm dist-tag a version is released under: pre-releases go to `next`. */
export function channelOf(version: string): 'latest' | 'next' {
  return version.includes('-') ? 'next' : 'latest';
}
