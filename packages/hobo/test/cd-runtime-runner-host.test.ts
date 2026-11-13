// How the Station's CD runtime plans the runner fleet's Freight into a Set
// (cd-runtime.ts): the runner-host planner offering, the fleet's Bindle
// declaration paired with a Freight its source discovered, and each
// runner-host row bound to the controller its Freight pins. Offline, over
// the real `@hobo/cloud` planner and the `@hobo/cd` planning resolver.
import { create } from "@bufbuild/protobuf";
import { canonicalManifestHash, parseManifest } from "@hobo/bindles";
import {
	ArtifactKind,
	AssemblyRule,
	type CampId,
	CampManagement,
	type CampTopology,
	type CdContext,
	type DesiredStateReader,
	FreightManifestRecordSchema,
	FreightOrigin,
	type FreightRecord,
	FreightRecordSchema,
	FreightSourceRecordSchema,
	type SetRecord,
	SetRecordSchema,
	SubscriptionKind,
} from "@hobo/cd";
import { createPlanningResolver } from "@hobo/cd/promotion";
import { definitionDigest } from "@hobo/cd/sources";
import {
	RUNNER_FLEET_BINDLE,
	RUNNER_HOST_PRODUCT_ID,
	runnerFleetDeclaration,
} from "@hobo/ci-gh-actions/runner-host";
import {
	createRegistryFromProviders,
	type ResolvedDeploymentSet,
} from "@hobo/cloud";
import { describe, expect, it } from "vitest";
import {
	catalogPlannerProviders,
	runnerHostPlannerProviders,
	sourceDeclaredBindle,
	withRunnerHostRealization,
} from "../src/cd-runtime.js";
import { openCdStore } from "../src/cd-store.js";
import { imageAt, runnerHostResolvedSet } from "./fixtures/runner-host-fake.js";

// SAFETY: runner fleet Camp ids (hobo-ci-runners/<host id>) and one outside it.
const BOX = "hobo-ci-runners/box" as CampId;
// SAFETY: as above.
const RELEASE = "hobo-release/oci-candidate" as CampId;
const TARGET = imageAt("2");
const ctx: CdContext = {
	tenant: "local",
	principal: { kind: "service", id: "test" },
	now: () => Date.parse("2026-11-12T10:00:00.000Z"),
};

function camp(campId: string, provider: string): CampTopology {
	return {
		campId,
		yardId: campId.split("/")[0] ?? "",
		stationId: "",
		provider,
		regions: [],
		envType: "ci",
		labels: {},
		management: CampManagement.MANAGED,
	};
}

/** The fleet's applied source, as `pipeline apply` records it. */
const SOURCE = create(FreightSourceRecordSchema, {
	schemaVersion: "hobo.cd.source/v1",
	name: "hobo-ci-runner-image",
	bindle: RUNNER_FLEET_BINDLE,
	subscriptions: [
		{
			name: "hobo-ci-runner-image",
			kind: SubscriptionKind.OCI_REPOSITORY,
			locator: "ghcr.io/hobo-labs/hobo/hobo-ci-worker",
			artifactName: "hobo-ci-worker",
			artifactKind: ArtifactKind.OCI_IMAGE,
		},
	],
	assembly: AssemblyRule.INDEPENDENT,
});

function freight(
	input: Readonly<{
		image?: string;
		origin?: FreightOrigin;
		declarationHash?: string;
		bindle?: string;
	}> = {},
): FreightRecord {
	const image = input.image ?? TARGET;
	return create(FreightRecordSchema, {
		freightId: `sha256:${"a".repeat(64)}`,
		origin: input.origin ?? FreightOrigin.SOURCE_DISCOVERY,
		sourceName: SOURCE.name,
		manifest: create(FreightManifestRecordSchema, {
			bindle: input.bindle ?? RUNNER_FLEET_BINDLE,
			declarationHash: input.declarationHash ?? definitionDigest(SOURCE),
			artifacts: [
				{
					name: "hobo-ci-worker",
					kind: ArtifactKind.OCI_IMAGE,
					digest: image.slice(image.indexOf("@") + 1),
					coordinate: image,
				},
			],
		}),
	});
}

/** A desired-state reader holding at most one current Set per Camp. */
function desiredWith(
	current: Readonly<Record<string, ResolvedDeploymentSet>> = {},
): DesiredStateReader {
	const sets = new Map<string, SetRecord>(
		Object.entries(current).map(([campId, resolved]) => [
			campId,
			create(SetRecordSchema, {
				setId: `set_${campId}`,
				campId,
				contentHash: resolved.contentHash,
			}),
		]),
	);
	return {
		current: async (campId) => sets.get(campId),
		get: async () => undefined,
		history: async () => [],
		resolved: async (set) => {
			const resolved = current[set.campId];
			if (!resolved) throw new Error(`no resolved Set for ${set.campId}`);
			return resolved;
		},
		status: async () => undefined,
		async *changes() {},
	};
}

/** The Station's resolver for the runner fleet, as cd-runtime composes it. */
async function resolverFor(
	camps: readonly CampTopology[],
	desired: DesiredStateReader = desiredWith(),
) {
	const opened = await openCdStore({ backend: "memory" }, { now: ctx.now });
	const bound = new WeakMap<object, `sha256:${string}`>();
	const planning = createPlanningResolver({
		store: opened.store,
		tenant: "local",
		now: ctx.now,
		desired,
		registry: createRegistryFromProviders([
			...catalogPlannerProviders(camps),
			...runnerHostPlannerProviders(camps),
		]),
		declarationDigest: (declaration) =>
			bound.get(declaration) ?? canonicalManifestHash(declaration),
		async declaration(record) {
			const declared = sourceDeclaredBindle(record, [SOURCE]);
			if (!declared) return undefined;
			const declaration = parseManifest(declared.declaration);
			bound.set(declaration, declared.digest);
			return declaration;
		},
		camp: async (campId) =>
			camps.some((entry) => entry.campId === campId)
				? { environment: "ci", config: {} }
				: undefined,
	});
	return {
		resolver: withRunnerHostRealization(planning, desired),
		close: opened.close,
	};
}

describe("the runner-host planner offering", () => {
	it("offers each runner host Camp's provider exactly the runner-host product, and nothing for other Camps", () => {
		const providers = runnerHostPlannerProviders([
			camp(BOX, "self-hosted"),
			camp("hobo-ci-runners/mesh-a", "self-hosted"),
			camp(RELEASE, "@hobo/provider-oci-registry"),
		]);
		expect(providers.map((provider) => provider.id)).toEqual(["self-hosted"]);
		const [capability] = providers[0]?.capabilities ?? [];
		expect(capability?.port).toBe(RUNNER_HOST_PRODUCT_ID);
		// SAFETY: minimal planner requests; satisfies reads only port and features.
		expect(capability?.satisfies({ port: "compute" } as never)).toEqual({
			kind: "none",
		});
		expect(
			// SAFETY: as above.
			capability?.satisfies({ port: RUNNER_HOST_PRODUCT_ID } as never),
		).toEqual({ kind: "full" });
		expect(runnerHostPlannerProviders([camp(RELEASE, "self-hosted")])).toEqual(
			[],
		);
	});
});

describe("the runner fleet's declaration pairs with a Freight its source discovered", () => {
	it("pairs while the applied source still has the Freight's declaration digest", () => {
		const declared = sourceDeclaredBindle(freight(), [SOURCE]);
		expect(declared?.digest).toBe(definitionDigest(SOURCE));
		expect(declared?.declaration).toEqual(runnerFleetDeclaration());
	});

	it("refuses a hand-ingested Freight, a redefined source, an unknown source and another Bindle", () => {
		expect(
			sourceDeclaredBindle(freight({ origin: FreightOrigin.MANIFEST }), [
				SOURCE,
			]),
		).toBeUndefined();
		const redefined = create(FreightSourceRecordSchema, {
			...SOURCE,
			assembly: AssemblyRule.SAME_VERSION,
		});
		expect(sourceDeclaredBindle(freight(), [redefined])).toBeUndefined();
		expect(sourceDeclaredBindle(freight(), [])).toBeUndefined();
		expect(
			sourceDeclaredBindle(freight({ bindle: "hobo-ci-relay" }), [SOURCE]),
		).toBeUndefined();
	});
});

describe("Matching resolves the runner fleet's Freight into a runner-host Set", () => {
	it("plans the controller on the box's own provider, its row pinned to the Freight's image", async () => {
		const { resolver, close } = await resolverFor([camp(BOX, "self-hosted")]);
		try {
			const outcome = await resolver.resolve(
				{ freight: freight(), campId: BOX, intent: "promote" },
				ctx,
			);
			if (!outcome.ok) throw new Error(outcome.reasons[0]?.message);
			const { resolved, delta } = outcome.value;
			expect(resolved.plan.resources).toEqual([
				expect.objectContaining({
					name: "runner-controller",
					provider: "self-hosted",
					productId: RUNNER_HOST_PRODUCT_ID,
					realizationParameters: { image: TARGET },
				}),
			]);
			expect(resolved.matches[0]?.providerId).toBe("self-hosted");
			// The Delta is over the bound Set, not the unbound plan.
			expect(delta.changes).toHaveLength(1);
			expect(delta.changes[0]?.afterHash).not.toBe("");
			expect(delta.deltaId).toMatch(/^delta_[0-9a-f]{24}$/u);
		} finally {
			await close();
		}
	});

	it("diffs against the Camp's current Set: the same image is no change", async () => {
		const current = runnerHostResolvedSet({ campId: BOX, image: TARGET });
		const { resolver, close } = await resolverFor(
			[camp(BOX, "self-hosted")],
			desiredWith({ [BOX]: current }),
		);
		try {
			const again = await resolver.resolve(
				{ freight: freight(), campId: BOX, intent: "promote" },
				ctx,
			);
			if (!again.ok) throw new Error(again.reasons[0]?.message);
			const next = await resolver.resolve(
				{
					freight: freight({ image: imageAt("3") }),
					campId: BOX,
					intent: "promote",
				},
				ctx,
			);
			if (!next.ok) throw new Error(next.reasons[0]?.message);
			expect(next.value.delta.changes.map((c) => c.resource)).toEqual([
				"runner-controller",
			]);
			expect(again.value.delta.deltaId).not.toBe(next.value.delta.deltaId);
		} finally {
			await close();
		}
	});

	it("refuses a Freight whose declaration it cannot pair, and one with no digest-pinned image", async () => {
		const { resolver, close } = await resolverFor([camp(BOX, "self-hosted")]);
		try {
			const ingested = await resolver.resolve(
				{
					freight: freight({ origin: FreightOrigin.MANIFEST }),
					campId: BOX,
					intent: "promote",
				},
				ctx,
			);
			expect(ingested.ok ? "" : ingested.reasons[0]?.code).toBe(
				"planning-declaration-missing",
			);
			const unpinned = await resolver.resolve(
				{
					freight: freight({
						image: "ghcr.io/hobo-labs/hobo/hobo-ci-worker:latest",
					}),
					campId: BOX,
					intent: "promote",
				},
				ctx,
			);
			expect(unpinned.ok ? "" : unpinned.reasons[0]?.code).toBe(
				"runner-host-image-unresolved",
			);
		} finally {
			await close();
		}
	});

	it("refuses a runner-host row planned for a Camp outside the fleet", async () => {
		const { resolver, close } = await resolverFor([
			camp(BOX, "self-hosted"),
			camp(RELEASE, "self-hosted"),
		]);
		try {
			const outside = await resolver.resolve(
				{ freight: freight(), campId: RELEASE, intent: "promote" },
				ctx,
			);
			expect(outside.ok ? "" : outside.reasons[0]?.code).toBe(
				"runner-host-camp-unbound",
			);
		} finally {
			await close();
		}
	});

	it("passes a teardown through unchanged", async () => {
		const current = runnerHostResolvedSet({ campId: BOX, image: TARGET });
		const { resolver, close } = await resolverFor(
			[camp(BOX, "self-hosted")],
			desiredWith({ [BOX]: current }),
		);
		try {
			const down = await resolver.resolve(
				{ freight: freight(), campId: BOX, intent: "down" },
				ctx,
			);
			if (!down.ok) throw new Error(down.reasons[0]?.message);
			expect(down.value.resolved.plan.resources).toEqual([]);
		} finally {
			await close();
		}
	});
});
