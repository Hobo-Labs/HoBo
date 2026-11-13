// The CI bridge and the seam through which HoBo delivers itself (WP18, plan
// 0024, C15).
//
// HoBo CI enters CD as an ordinary pull subscription: a `HOBO_CI` Freight
// source whose driver reads CI events structurally (the frozen CiEventReader)
// and re-reads every output to verify its digest. A CI event triggers; the
// read decides (I15). Nothing here creates Freight.
//
// HoBo delivering itself: HoBo's own CI relay and runner-fleet components are
// delivered by `hobo deploy` through exactly this path. The sources below are
// the records `hobo deploy source define` applies for them. The relay's
// pipeline (preview -> production) is delivery-as-code beside its Yard
// (`packages/ci-vercel/deploy/delivery.ts`) and `hobo ci deploy` promotes
// through it; both use these names.
import { create } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	AssemblyRule,
	type FreightSourceRecord,
	FreightSourceRecordSchema,
	SelectionStrategy,
	SubscriptionKind,
	SubscriptionRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, SOURCE_SCHEMA } from "../events.js";

export type HoboCiSourceInput = Readonly<{
	/** Freight source name (`cd-source-<name>`). */
	name: string;
	/** Bindle the Freight is for. */
	bindle: string;
	/** CI pipeline id or repository whose passing runs are read. */
	pipeline: string;
	/** Exact output paths (one subscription each); empty reads every output. */
	outputs?: readonly Readonly<{ path: string; kind: ArtifactKind }>[];
	branch?: string;
	/** Default true: automatic polling at CD_DEFAULTS.sourcePollIntervalMs. */
	automatic?: boolean;
	requireProvenance?: boolean;
	trustedBuilderIds?: readonly string[];
	definedBy?: string;
}>;

/** A `HOBO_CI` Freight source (C15): CI events trigger, verified reads decide. */
export function hoboCiSource(input: HoboCiSourceInput): FreightSourceRecord {
	const outputs = input.outputs ?? [];
	const subscriptions = (outputs.length === 0 ? [undefined] : outputs).map(
		(output, index) =>
			create(SubscriptionRecordSchema, {
				name: output ? `${input.name}-${index + 1}` : input.name,
				kind: SubscriptionKind.HOBO_CI,
				locator: input.pipeline,
				selection: SelectionStrategy.NEWEST_BUILD,
				branch: input.branch ?? "",
				discoveryLimit: CD_DEFAULTS.sourceDiscoveryLimit,
				requireProvenance: input.requireProvenance ?? false,
				trustedBuilderIds: [...(input.trustedBuilderIds ?? [])],
				artifactName: output?.path ?? "",
				artifactKind: output?.kind ?? ArtifactKind.UNSPECIFIED,
			}),
	);
	return create(FreightSourceRecordSchema, {
		schemaVersion: SOURCE_SCHEMA,
		name: input.name,
		bindle: input.bindle,
		subscriptions,
		// Every output of one CI run belongs to one commit.
		assembly:
			subscriptions.length > 1
				? AssemblyRule.SAME_COMMIT
				: AssemblyRule.INDEPENDENT,
		automatic: input.automatic ?? true,
		pollIntervalMs: BigInt(CD_DEFAULTS.sourcePollIntervalMs),
		definedBy: input.definedBy ?? "",
	});
}

// public-contract: the HoBo CI components CD delivers for HoBo itself.
export const HOBO_CI_COMPONENTS = Object.freeze({
	relay: Object.freeze({
		bindle: "hobo-ci-relay",
		source: "hobo-ci-relay",
		pipeline: "hobo-ci-relay",
	}),
	runnerFleet: Object.freeze({
		bindle: "hobo-ci-runner-fleet",
		source: "hobo-ci-runner-fleet",
		pipeline: "hobo-ci-runner-fleet",
	}),
} as const);

/**
 * The Freight sources that deliver HoBo's own CI relay and runner fleet
 * through CD. `ciPipeline` is the CI pipeline (or repository) that builds
 * HoBo; each component's outputs are read from its passing runs.
 */
export function hoboSelfDeliverySources(
	input: Readonly<{
		ciPipeline: string;
		branch?: string;
		relayOutputs?: readonly Readonly<{ path: string; kind: ArtifactKind }>[];
		runnerFleetOutputs?: readonly Readonly<{
			path: string;
			kind: ArtifactKind;
		}>[];
		requireProvenance?: boolean;
		definedBy?: string;
	}>,
): readonly FreightSourceRecord[] {
	const common = {
		pipeline: input.ciPipeline,
		...(input.branch !== undefined ? { branch: input.branch } : undefined),
		...(input.requireProvenance !== undefined
			? { requireProvenance: input.requireProvenance }
			: undefined),
		...(input.definedBy !== undefined
			? { definedBy: input.definedBy }
			: undefined),
	};
	return [
		hoboCiSource({
			...common,
			name: HOBO_CI_COMPONENTS.relay.source,
			bindle: HOBO_CI_COMPONENTS.relay.bindle,
			outputs: input.relayOutputs ?? [
				{ path: "relay/bundle", kind: ArtifactKind.FUNCTION_BUNDLE },
			],
		}),
		hoboCiSource({
			...common,
			name: HOBO_CI_COMPONENTS.runnerFleet.source,
			bindle: HOBO_CI_COMPONENTS.runnerFleet.bindle,
			outputs: input.runnerFleetOutputs ?? [
				{ path: "runner-fleet/image", kind: ArtifactKind.OCI_IMAGE },
			],
		}),
	];
}

/**
 * @deprecated Use `hoboSelfDeliverySources`; this alias keeps earlier callers
 * compiling and will be removed once they have moved.
 */
export const hoboCiDogfoodSources = hoboSelfDeliverySources;
