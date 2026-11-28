import type { PackVersion } from "./manifest.js";

export interface UpgradeCandidate {
	readonly packVersion: PackVersion;
	readonly profileIds: readonly string[];
	readonly verified: boolean;
}

export interface PackUpgradeInput {
	readonly packId: string;
	readonly installed: UpgradeCandidate;
	readonly available: readonly UpgradeCandidate[];
	readonly acceptMajor?: number;
}

export type PackUpgradeReason =
	| "newer-in-major"
	| "major-boundary"
	| "major-accepted"
	| "unverified-target"
	| "profile-dropped";

export type PackUpgradeAction = "hold" | "upgrade" | "blocked";

export interface PackUpgradeVerdict {
	readonly packId: string;
	readonly action: PackUpgradeAction;
	readonly installed: UpgradeCandidate;
	readonly target?: UpgradeCandidate;
	readonly reasons: readonly PackUpgradeReason[];
	readonly availableMajors: readonly number[];
	readonly droppedProfiles: readonly string[];
}

function parts(version: PackVersion): [number, number, number] {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	return [major, minor, patch];
}

export function comparePackVersions(a: PackVersion, b: PackVersion): number {
	const left = parts(a);
	const right = parts(b);
	for (let index = 0; index < 3; index += 1) {
		// SAFETY: `const difference = (left[index] as number) - (right[index] as number);` is required at this I/O or test boundary.
		const difference = (left[index] as number) - (right[index] as number);
		if (difference !== 0) return difference;
	}
	return 0;
}

export function latestSatisfying(
	versions: readonly PackVersion[],
	major: number,
): PackVersion | undefined {
	let best: PackVersion | undefined;
	for (const version of versions) {
		if (parts(version)[0] !== major) continue;
		if (best === undefined || comparePackVersions(version, best) > 0)
			best = version;
	}
	return best;
}

function highestIn(
	candidates: readonly UpgradeCandidate[],
	major: number,
): UpgradeCandidate | undefined {
	let best: UpgradeCandidate | undefined;
	for (const candidate of candidates) {
		if (parts(candidate.packVersion)[0] !== major) continue;
		if (
			best === undefined ||
			comparePackVersions(candidate.packVersion, best.packVersion) > 0
		)
			best = candidate;
	}
	return best;
}

export function planPackUpgrade(input: PackUpgradeInput): PackUpgradeVerdict {
	const installedMajor = parts(input.installed.packVersion)[0];
	const reasons: PackUpgradeReason[] = [];

	const availableMajors = [
		...new Set(
			input.available
				.map((candidate) => parts(candidate.packVersion)[0])
				.filter((major) => major > installedMajor),
		),
	].sort((a, b) => a - b);

	const inMajor = highestIn(input.available, installedMajor);
	let target =
		inMajor !== undefined &&
		comparePackVersions(inMajor.packVersion, input.installed.packVersion) > 0
			? inMajor
			: undefined;
	if (target !== undefined) reasons.push("newer-in-major");

	if (availableMajors.length > 0) {
		const accepted =
			input.acceptMajor !== undefined && input.acceptMajor > installedMajor
				? highestIn(input.available, input.acceptMajor)
				: undefined;
		if (accepted !== undefined) {
			target = accepted;
			reasons.length = 0;
			reasons.push("major-accepted");
		} else {
			reasons.push("major-boundary");
		}
	}

	if (target === undefined) {
		return {
			packId: input.packId,
			action: "hold",
			installed: input.installed,
			reasons: reasons.sort(),
			availableMajors,
			droppedProfiles: [],
		};
	}

	const targetProfiles = new Set(target.profileIds);
	const droppedProfiles = input.installed.profileIds
		.filter((profileId) => !targetProfiles.has(profileId))
		.sort();

	if (!target.verified) reasons.push("unverified-target");
	if (droppedProfiles.length > 0) reasons.push("profile-dropped");

	const blocked = !target.verified || droppedProfiles.length > 0;

	return {
		packId: input.packId,
		action: blocked ? "blocked" : "upgrade",
		installed: input.installed,
		target,
		reasons: reasons.sort(),
		availableMajors,
		droppedProfiles,
	};
}
