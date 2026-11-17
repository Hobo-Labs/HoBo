import * as path from 'path';

export function toPathKey(p: string): string {
  if (!p) return p;
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function pathsMatch(left: string, right: string): boolean {
  return toPathKey(left) === toPathKey(right);
}

export class PathSet extends Set<string> {
  override add(value: string): this {
    return super.add(toPathKey(value));
  }

  override has(value: string): boolean {
    return super.has(toPathKey(value));
  }

  override delete(value: string): boolean {
    return super.delete(toPathKey(value));
  }
}
