// Semantic Version 2.0.0 precedence for the `semver-gte` posture operator.
// Accepts an optional leading `v` and a missing minor/patch (read as 0), the
// forms platform versions are reported in ("1.2", "v1.27.3").

export type Semver = Readonly<{
	major: number;
	minor: number;
	patch: number;
	prerelease: readonly string[];
}>;

const SEMVER =
	/^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const NUMERIC = /^(0|[1-9]\d*)$/u;

export function parseSemver(value: string): Semver | undefined {
	const match = SEMVER.exec(value);
	if (!match) return undefined;
	const [, major = "0", minor = "0", patch = "0", prerelease] = match;
	const numbers = [major, minor, patch].map(Number);
	if (!numbers.every(Number.isSafeInteger)) return undefined;
	return {
		major: numbers[0] ?? 0,
		minor: numbers[1] ?? 0,
		patch: numbers[2] ?? 0,
		prerelease: prerelease === undefined ? [] : prerelease.split("."),
	};
}

function compareIdentifier(a: string, b: string): number {
	const an = NUMERIC.test(a);
	const bn = NUMERIC.test(b);
	if (an && bn) return Math.sign(Number(a) - Number(b));
	if (an) return -1;
	if (bn) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Precedence of `a` against `b` (negative, zero, positive), or undefined when either does not parse. */
export function compareSemver(a: string, b: string): number | undefined {
	const left = parseSemver(a);
	const right = parseSemver(b);
	if (!left || !right) return undefined;
	for (const key of ["major", "minor", "patch"] as const) {
		const diff = left[key] - right[key];
		if (diff !== 0) return Math.sign(diff);
	}
	if (left.prerelease.length === 0 || right.prerelease.length === 0)
		return Math.sign(right.prerelease.length - left.prerelease.length);
	const length = Math.max(left.prerelease.length, right.prerelease.length);
	for (let i = 0; i < length; i += 1) {
		const x = left.prerelease[i];
		const y = right.prerelease[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const diff = compareIdentifier(x, y);
		if (diff !== 0) return diff;
	}
	return 0;
}
