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
	name: string;
	bindle: string;
	pipeline: string;
	outputs?: readonly Readonly<{ path: string; kind: ArtifactKind }>[];
	branch?: string;
	automatic?: boolean;
	requireProvenance?: boolean;
	trustedBuilderIds?: readonly string[];
	definedBy?: string;
}>;

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
		assembly:
			subscriptions.length > 1
				? AssemblyRule.SAME_COMMIT
				: AssemblyRule.INDEPENDENT,
		automatic: input.automatic ?? true,
		pollIntervalMs: BigInt(CD_DEFAULTS.sourcePollIntervalMs),
		definedBy: input.definedBy ?? "",
	});
}

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
