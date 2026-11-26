/**
 * Capability profile registry: an acyclic, versioned refinement graph.
 *
 * Satisfying a child profile satisfies its ancestors. The reverse is never
 * inferred — `data.postgres/v1` satisfies `data.relational/v1`, but a product
 * that only implements `data.relational/v1` (Cloudflare D1) never satisfies
 * `data.postgres/v1`.
 */
import { createHash } from "node:crypto";

import {
	type CapabilityProfileDescriptor,
	CapabilityProfileError,
	type ParsedCapabilityProfile,
	type ProfileId,
	parseCapabilityProfile,
	parseProfileId,
} from "@hobo/manifest-capability";

export type CapabilityProfileRegistry = {
	/** Deterministic digest over every selection-relevant profile fact. */
	readonly digest: string;
	get(id: string): ParsedCapabilityProfile | undefined;
	require(id: string): ParsedCapabilityProfile;
	has(id: string): boolean;
	list(): readonly ParsedCapabilityProfile[];
	/** The profile plus every profile it transitively refines. */
	closureOf(id: string): readonly ProfileId[];
	/** True when `candidate` satisfies `required` through refinement. */
	satisfies(candidate: string, required: string): boolean;
	/** Guarantee keys visible on a profile including inherited ones. */
	guaranteeKeys(id: string): readonly string[];
};

function digestOf(profiles: readonly ParsedCapabilityProfile[]): string {
	const summary = profiles
		.map((profile) => ({
			id: profile.id,
			primitive: profile.primitive,
			refines: profile.refines,
			requires: profile.requires,
			conflictsWith: profile.conflictsWith,
			maturity: profile.maturity,
			features: [...profile.features]
				.map((feature) => ({
					key: feature.key,
					valueKind: feature.valueKind,
					enumValues: feature.enumValues
						? [...feature.enumValues].sort()
						: undefined,
				}))
				.sort((a, b) => a.key.localeCompare(b.key)),
			guarantees: [...profile.guarantees]
				.map((guarantee) => ({
					key: guarantee.key,
					valueKind: guarantee.valueKind,
					enumValues: guarantee.enumValues
						? [...guarantee.enumValues].sort()
						: undefined,
				}))
				.sort((a, b) => a.key.localeCompare(b.key)),
			conformanceSuiteRef: profile.conformanceSuiteRef,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	return `sha256:${createHash("sha256").update(JSON.stringify(summary)).digest("hex")}`;
}

/**
 * Build a registry. Rejects unknown refinement targets, duplicate IDs, and
 * refinement cycles at load time rather than at match time.
 */
export function createCapabilityProfileRegistry(
	descriptors: readonly CapabilityProfileDescriptor[],
): CapabilityProfileRegistry {
	const parsed = new Map<ProfileId, ParsedCapabilityProfile>();
	for (const descriptor of descriptors) {
		const profile = parseCapabilityProfile(descriptor);
		if (parsed.has(profile.id)) {
			throw new CapabilityProfileError(
				"INVALID_CAPABILITY_PROFILE",
				`duplicate capability profile ${profile.id}`,
				profile.id,
			);
		}
		parsed.set(profile.id, profile);
	}

	for (const profile of parsed.values()) {
		for (const parent of profile.refines) {
			const target = parsed.get(parent);
			if (target === undefined) {
				throw new CapabilityProfileError(
					"UNKNOWN_PROFILE",
					`${profile.id} refines unregistered profile ${parent}`,
					profile.id,
				);
			}
			// A refinement may add guarantees but must not cross primitives.
			if (target.primitive !== profile.primitive) {
				throw new CapabilityProfileError(
					"INVALID_CAPABILITY_PROFILE",
					`${profile.id} (${profile.primitive}) cannot refine ${parent} (${target.primitive})`,
					profile.id,
				);
			}
		}
		for (const required of profile.requires) {
			if (!parsed.has(required)) {
				throw new CapabilityProfileError(
					"UNKNOWN_PROFILE",
					`${profile.id} requires unregistered profile ${required}`,
					profile.id,
				);
			}
		}
		for (const conflict of profile.conflictsWith) {
			if (!parsed.has(conflict)) {
				throw new CapabilityProfileError(
					"UNKNOWN_PROFILE",
					`${profile.id} conflicts with unregistered profile ${conflict}`,
					profile.id,
				);
			}
		}
	}

	// Iterative DFS cycle detection over the refinement edges.
	const WHITE = 0;
	const GREY = 1;
	const BLACK = 2;
	const colour = new Map<ProfileId, number>();
	for (const id of parsed.keys()) colour.set(id, WHITE);
	for (const root of [...parsed.keys()].sort((a, b) => a.localeCompare(b))) {
		if (colour.get(root) !== WHITE) continue;
		const stack: { id: ProfileId; index: number }[] = [{ id: root, index: 0 }];
		colour.set(root, GREY);
		while (stack.length > 0) {
			// SAFETY: stack length is checked above, so the top frame exists.
			const frame = stack[stack.length - 1] as { id: ProfileId; index: number };
			// SAFETY: every stack frame was pushed from a parsed profile key.
			const node = parsed.get(frame.id) as ParsedCapabilityProfile;
			if (frame.index >= node.refines.length) {
				colour.set(frame.id, BLACK);
				stack.pop();
				continue;
			}
			// SAFETY: frame.index is bounded by node.refines.length above.
			const next = node.refines[frame.index] as ProfileId;
			frame.index += 1;
			const state = colour.get(next);
			if (state === GREY) {
				throw new CapabilityProfileError(
					"PROFILE_REFINEMENT_CYCLE",
					`capability profile refinement cycle through ${frame.id} -> ${next}`,
					frame.id,
				);
			}
			if (state === WHITE) {
				colour.set(next, GREY);
				stack.push({ id: next, index: 0 });
			}
		}
	}

	const closures = new Map<ProfileId, readonly ProfileId[]>();
	const closureOf = (id: ProfileId): readonly ProfileId[] => {
		const cached = closures.get(id);
		if (cached !== undefined) return cached;
		const seen = new Set<ProfileId>();
		const queue: ProfileId[] = [id];
		while (queue.length > 0) {
			// SAFETY: queue length is checked above, so a queued profile exists.
			const current = queue.shift() as ProfileId;
			if (seen.has(current)) continue;
			seen.add(current);
			const node = parsed.get(current);
			if (node === undefined) continue;
			for (const parent of node.refines) queue.push(parent);
		}
		const result = [...seen].sort((a, b) => a.localeCompare(b));
		closures.set(id, result);
		return result;
	};

	const profiles = [...parsed.values()].sort((a, b) =>
		a.id.localeCompare(b.id),
	);

	const registry: CapabilityProfileRegistry = {
		digest: digestOf(profiles),
		get(id) {
			const ref = (() => {
				try {
					return parseProfileId(id).id;
				} catch {
					return undefined;
				}
			})();
			return ref === undefined ? undefined : parsed.get(ref);
		},
		require(id) {
			const profile = registry.get(id);
			if (profile === undefined) {
				throw new CapabilityProfileError(
					"UNKNOWN_PROFILE",
					`unknown capability profile ${id}`,
					id,
				);
			}
			return profile;
		},
		has(id) {
			return registry.get(id) !== undefined;
		},
		list() {
			return profiles;
		},
		closureOf(id) {
			return closureOf(registry.require(id).id);
		},
		satisfies(candidate, required) {
			const candidateProfile = registry.get(candidate);
			const requiredProfile = registry.get(required);
			if (candidateProfile === undefined || requiredProfile === undefined) {
				return false;
			}
			return closureOf(candidateProfile.id).includes(requiredProfile.id);
		},
		guaranteeKeys(id) {
			const keys = new Set<string>();
			for (const ancestor of closureOf(registry.require(id).id)) {
				const node = parsed.get(ancestor);
				if (node === undefined) continue;
				for (const guarantee of node.guarantees) keys.add(guarantee.key);
			}
			return [...keys].sort((a, b) => a.localeCompare(b));
		},
	};

	return registry;
}
