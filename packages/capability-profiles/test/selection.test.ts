/**
 * Every case is a line in `selection.cases.jsonl`.
 *
 * Two shorthands keep the data readable: a candidate is a patch over one base
 * candidate, and `profiles` expands a profile id into the full conformance
 * claim. The suite this replaced restated that five-field claim eight times to
 * change one field of it.
 */

import { describeConcern } from "@hobo/contract-harness";
import {
	type CapabilityRequirementInput,
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	type SelectionCandidate,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
	type TrustPolicy,
} from "../src/index.js";

const registry = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);
const NOW = Date.UTC(2026, 7, 8);
const FRESH = NOW + 20 * 24 * 60 * 60 * 1000;

const POSTGRES = { requiredProfiles: [{ profileId: "data.postgres/v1" }] };

const BASE: SelectionCandidate = {
	definitionId: "test.definition/v1",
	providerId: "test",
	implementsProfiles: [
		{
			profileId: "data.postgres/v1",
			versionRange: ">=1",
			realization: "native",
			conformanceRef: "conformance.data.postgres/v1",
			conformance: "pass",
		},
	],
	runtimeModels: ["paas"],
	structuredCapabilities: {},
	producesBindingProfiles: ["binding.postgresql/v1"],
	migrationProfiles: ["migration.postgres.pg-dump/v1"],
	providerClass: "verified-emerging",
	evidenceExpiresAtMs: FRESH,
	evidenceSignatureValid: true,
	creatorAuthorityAfterClaim: "rotatable",
	claimAtomicity: "single-resource",
	claimActionCount: 1,
	continuity: {
		endpoint: "preserved",
		data: "preserved",
		credentials: "rotated",
	},
	supportsExport: true,
	supportsRotation: true,
	supportsRevocation: true,
	sponsorExposureMinorUnits: 0,
	hasRegisteredDriver: true,
	secretCustodyAvailable: true,
};

/** A profile id, optionally with the one field the case is actually varying. */
type ProfileShorthand =
	| string
	| {
			readonly id: string;
			readonly realization?: string;
			readonly conformance?: string;
	  };

interface CandidatePatch extends Partial<SelectionCandidate> {
	readonly profiles?: readonly ProfileShorthand[];
	/** Present so a case can say "this field is absent", which a patch cannot. */
	readonly absent?: readonly string[];
}

function toCandidate(patch: CandidatePatch): SelectionCandidate {
	const { profiles, absent, ...rest } = patch;
	// SAFETY: the patch starts from a complete candidate and only overrides known fields.
	const draft = { ...BASE, ...rest } as SelectionCandidate;
	if (profiles)
		draft.implementsProfiles = profiles.map((entry) => {
			const spec = Object(entry) === entry ? entry : { id: String(entry) };
			return {
				profileId: spec.id,
				versionRange: ">=1",
				realization: spec.realization ?? "native",
				conformanceRef: `conformance.${spec.id}`,
				conformance: spec.conformance ?? "pass",
			};
		});
	for (const key of absent ?? []) delete draft[key];
	return draft;
}

interface Ask {
	readonly candidates: readonly CandidatePatch[];
	/** Merged over the default policy: only the field under test needs naming. */
	readonly policy?: Partial<TrustPolicy>;
	readonly requirement?: CapabilityRequirementInput;
	readonly consumableBindingProfiles?: readonly string[];
	/** Run the same candidates in reverse, to prove order does not decide. */
	readonly reversed?: boolean;
}

function run(ask: Ask) {
	const candidates = ask.candidates.map(toCandidate);
	const selectionInput = {
		requirement: parseCapabilityRequirement(ask.requirement ?? POSTGRES),
		registry,
		candidates: ask.reversed ? [...candidates].reverse() : candidates,
		policy: { ...DEFAULT_TRUST_POLICY, ...ask.policy },
		nowMs: NOW,
	};
	if (ask.consumableBindingProfiles) {
		return selectCapabilityImplementation({
			...selectionInput,
			consumableBindingProfiles: ask.consumableBindingProfiles,
		});
	}
	return selectCapabilityImplementation(selectionInput);
}

const projection = (ask: Ask) => {
	const result = run(ask);
	return {
		winner: result.winner?.definitionId ?? null,
		rejections: result.rejections.map((rejection) => rejection.code),
		ranked: result.ranked.map((entry) => entry.definitionId),
	};
};

describeConcern("capability selection", {
	cases: `${import.meta.dirname}/selection.cases.jsonl`,
	subject: () => ({
		select: projection,
		/** Reordering must change neither the ranking nor the rejection evidence. */
		isOrderIndependent: (ask: Ask) =>
			JSON.stringify(projection({ ...ask, reversed: false })) ===
			JSON.stringify(projection({ ...ask, reversed: true })),
		/** Parsing is a gate of its own: a bad requirement must not reach selection. */
		parseRequirement: (input: CapabilityRequirementInput) =>
			JSON.stringify(parseCapabilityRequirement(input)),
	}),
});
