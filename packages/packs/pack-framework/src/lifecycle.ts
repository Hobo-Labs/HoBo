/**
 * Pack upgrade as a decision.
 *
 * A pack manifest carries a `<major>.<minor>.<patch>` version, and until this
 * module nothing in the repo could order two of them: `parsePackVersion`
 * checks the shape and stops. So the question every upgrade starts with — is
 * this one newer? — was unanswerable, and there was nowhere to put the rules
 * about whether an upgrade may proceed at all.
 *
 * ## What this is, and what it deliberately is not
 *
 * This is not an installer, a resolver over a dependency graph, or a
 * downloader. It answers one question — given what is installed and what
 * exists, what should happen, and may it? — and leaves fetching and swapping
 * to whatever performs the install. The split is what makes an upgrade
 * explainable after the fact: the verdict names its reasons, so a pack that
 * moved can say why, and a pack that did not can say why not.
 *
 * ## The rules, and where each one comes from
 *
 * **A major is a wall, not a step.** OLM's channels exist because silently
 * crossing a breaking-change boundary is how an upgrade eats a database. A new
 * major is reported, never taken, until it is named — and naming one major is
 * not consent to whatever an intervening major did on the way past.
 *
 * **A dropped profile claim blocks.** Consumers selected this pack because it
 * implements a profile. A version that stops implementing it is not an upgrade
 * for them, and a major bump explains a breaking change without excusing one
 * that was never named. Backstage's plugin treadmill is what the absence of
 * this check looks like at scale.
 *
 * **Unverified is blocked, never skipped.** The failure worse than refusing an
 * upgrade is quietly not doing it: that is how a pack sits three CVEs behind
 * while the surface reports it current. When the version that should be taken
 * cannot be trusted, the verdict says so and names it.
 *
 * **Downgrades are never automatic.** Rolling back is an operator decision. A
 * resolver that picks a lower version on its own has invented one.
 *
 * ## Scope
 *
 * Pack-to-pack dependencies are not modelled: packs declare capability
 * profiles, not other packs, so there is no graph to resolve today. The
 * profile-claim check is the honest half of "dependency resolution" that the
 * current data supports, and it is the half that actually breaks consumers.
 */
import type { PackVersion } from "./manifest.js";

/** A pack version available to install, with the facts an upgrade turns on. */
export interface UpgradeCandidate {
	readonly packVersion: PackVersion;
	/** Capability profiles this version claims to implement. */
	readonly profileIds: readonly string[];
	/**
	 * Whether this version's manifest passed `verifyPackManifest`. Reported by
	 * the caller, which is the only party that holds the trust anchors.
	 */
	readonly verified: boolean;
}

export interface PackUpgradeInput {
	readonly packId: string;
	readonly installed: UpgradeCandidate;
	/** Everything the caller knows about, in any order. */
	readonly available: readonly UpgradeCandidate[];
	/**
	 * A major version the operator has explicitly accepted. Absent means no
	 * major boundary may be crossed — silence is not consent to a breaking
	 * change.
	 */
	readonly acceptMajor?: number;
}

export type PackUpgradeReason =
	| "newer-in-major"
	| "major-boundary"
	| "major-accepted"
	| "unverified-target"
	| "profile-dropped";

/**
 * - `hold` — stay where we are.
 * - `upgrade` — `target` is the version to move to.
 * - `blocked` — a move is wanted but must not happen; `target` names what was
 *   refused, because a block with no subject is unactionable.
 */
export type PackUpgradeAction = "hold" | "upgrade" | "blocked";

export interface PackUpgradeVerdict {
	readonly packId: string;
	readonly action: PackUpgradeAction;
	readonly installed: UpgradeCandidate;
	/** The version chosen, or refused. Absent only when nothing was chosen. */
	readonly target?: UpgradeCandidate;
	/** Every reason that shaped the verdict, sorted. */
	readonly reasons: readonly PackUpgradeReason[];
	/**
	 * Majors above the installed one that exist. Reported whether or not they
	 * were taken: an operator who is never told a new major shipped cannot
	 * decide to accept it.
	 */
	readonly availableMajors: readonly number[];
	/** Profiles the installed version implements and the target does not. */
	readonly droppedProfiles: readonly string[];
}

function parts(version: PackVersion): [number, number, number] {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	return [major, minor, patch];
}

/**
 * Order two pack versions. Negative when `a` precedes `b`, as `Array#sort`
 * wants, so this can be passed to it directly.
 *
 * Numeric per-field comparison is the whole point: as strings, `1.10.0` sorts
 * below `1.9.0`, which would pick a nine-releases-stale version and call it an
 * upgrade.
 */
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

/** The highest version within one major, or `undefined` if that major has none. */
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

	// Within the installed major first. Reaching across a boundary is a separate
	// decision, and one the operator has to have made.
	const inMajor = highestIn(input.available, installedMajor);
	let target =
		inMajor !== undefined &&
		comparePackVersions(inMajor.packVersion, input.installed.packVersion) > 0
			? inMajor
			: undefined;
	if (target !== undefined) reasons.push("newer-in-major");

	if (availableMajors.length > 0) {
		// Accepting major N is consent to N, not to every major up to it. So we
		// look only at the accepted one, never at the highest available.
		const accepted =
			input.acceptMajor !== undefined && input.acceptMajor > installedMajor
				? highestIn(input.available, input.acceptMajor)
				: undefined;
		if (accepted !== undefined) {
			target = accepted;
			reasons.length = 0;
			reasons.push("major-accepted");
		} else {
			// Named but not taken. An operator who is never told a new major
			// shipped has no way to decide about it.
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

	// A refusal keeps its subject. "Blocked" with no version named tells an
	// operator nothing they can act on.
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
