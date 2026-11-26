import {
	CLOUD_EVENTS,
	collectStream,
	type DeploymentPlan,
	type IacDiff,
	type IacDriftReport,
	type IacOutputs,
	type IacProgram,
	type IacProvider,
} from "@hobo/cloud";
import type {
	CloudProvider,
	EventEnvelope,
	EventStore,
	IacProgramDocument,
	ResourcePlan,
} from "@hobo/core";
import { createPulumiAutomationAdapter } from "@hobo/iac-pulumi";
import {
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "./json.js";

// ---------------------------------------------------------------------------
// The REAL IaC backend on the deploy path (S0-01 integration gap closed).
//
// @hobo/cloud's Executor drives an injected `IacProvider` port whose methods
// receive the kernel's EXECUTION descriptor (shape-A `IacProgram`:
// programId/deploymentId/resourceId/provider/driver/action/stackName). The real
// @hobo/iac-pulumi adapter, however, consumes a DECLARATIVE `hobo.iac-program/v1`
// program (shape-B: { apiVersion, kind:"iac-program", resources:[...] }) that
// `validateIacProgram` accepts and `createCloudflareProvider().realize()` already
// emits (proven in provider-cloudflare/test/conformance-iac-pulumi.test.ts).
//
// This bridge is the composition-layer seam that connects them, keeping
// @hobo/cloud/src adapter-free: for each shape-A program the Executor hands us we
//   1. resolve the resource's real `ResourcePlan` from the durable
//      `deployment.Planned` fact already on the deployment stream (no cloud seam,
//      no fabricated plan — the same content-addressed plan the gateway stored),
//   2. call the REAL `provider.realize(resourcePlan)` -> shape-B program,
//   3. drive the REAL `@hobo/iac-pulumi` adapter's preview/apply/destroy/refresh
//      on that shape-B program (per-resource stack keyed off the plan's
//      deploymentId, threaded from the shape-A program so preview/apply/destroy
//      hit the same stack), and
//   4. map the adapter's per-resource-stack outputs/diff back to the kernel's
//      `IacDiff`/`IacOutputs`/`IacDriftReport`.
//
// HONEST SCOPE: the DEFAULT Pulumi backend is @hobo/iac-pulumi's in-memory
// Automation-API stand-in; the real pinned `pulumi` CLI engine exists
// (createPulumiCliAutomationEngine) and is selected with HOBO_PULUMI_LIVE=1 —
// binary- and credential-gated, exercised by the deploy-hello-bindle-pulumi
// workflow lane. Either way the deploy path runs the REAL adapter code and the
// REAL provider.realize() — there is no mock IacProvider.
// ---------------------------------------------------------------------------

// The subset of the @hobo/iac-pulumi adapter surface this bridge drives. The
// adapter is authored in loosely-typed JS-in-TS, so we pin the shapes we consume.
interface PulumiPreviewDiff {
	readonly changes: readonly unknown[];
	readonly dirty: boolean;
}
interface PulumiApplyOutputs {
	readonly resources: JsonObject;
	readonly stackOutputs?: JsonObject;
	readonly bindings?: JsonObject;
}
interface PulumiDriftReport {
	readonly drifted: boolean;
}
export interface PulumiAutomationAdapter {
	readonly id: string;
	preview(program: IacProgramDocument): Promise<PulumiPreviewDiff>;
	apply(program: IacProgramDocument): Promise<PulumiApplyOutputs>;
	destroy(program: IacProgramDocument): Promise<JsonValue>;
	refresh(program: IacProgramDocument): Promise<PulumiDriftReport>;
	snapshotState?(): JsonObject;
}

export interface PulumiBackedIacProviderOptions {
	readonly store: EventStore;
	readonly providers: readonly CloudProvider[];
	// The real @hobo/iac-pulumi adapter. Defaults to a fresh in-memory-backed
	// adapter; injectable so tests can spy on the adapter the deploy path drives.
	readonly adapter?: PulumiAutomationAdapter;
}

function planFromStream(
	events: readonly EventEnvelope[],
): DeploymentPlan | undefined {
	let plan: DeploymentPlan | undefined;
	for (const event of events) {
		if (event.type === CLOUD_EVENTS.DeploymentPlanned) {
			plan = (event.data as { plan: DeploymentPlan }).plan;
		}
	}
	return plan;
}

function toIacOutputs(result: PulumiApplyOutputs): IacOutputs {
	const outputs: IacOutputs = {};
	for (const [key, value] of Object.entries(result.stackOutputs ?? {})) {
		if (isJsonString(value)) outputs[key] = value;
	}
	for (const [key, value] of Object.entries(result.bindings ?? {})) {
		if (isJsonString(value)) outputs[key] = value;
	}
	return outputs;
}

export function createPulumiBackedIacProvider(
	options: PulumiBackedIacProviderOptions,
): IacProvider {
	const { store } = options;
	let adapter = options.adapter;
	if (adapter === undefined) {
		adapter = createPulumiAutomationAdapter() as PulumiAutomationAdapter;
	}
	const providersById = new Map<string, CloudProvider>(
		options.providers.map((provider) => [provider.id, provider]),
	);

	async function realizeFor(
		program: IacProgram,
	): Promise<IacProgramDocument | undefined> {
		const events = await collectStream(
			store,
			`deployment:${program.deploymentId}`,
		);
		const plan = planFromStream(events);
		const resource = plan?.resources.find((r) => r.name === program.resourceId);
		if (!resource) {
			return undefined;
		}
		const provider =
			providersById.get(program.provider) ??
			providersById.get(resource.provider);
		if (!provider) {
			throw new Error(
				`pulumi-iac-provider: no realize()-capable provider for ${program.provider}`,
			);
		}
		const { realizationParameters, ...planned } = resource;
		const resourcePlan: ResourcePlan = {
			...planned,
			deploymentId: program.deploymentId,
			...(realizationParameters !== undefined
				? {
						realizationParameters: parseJsonObject(
							JSON.stringify(realizationParameters),
						),
					}
				: undefined),
		};
		const { iac } = provider.realize(resourcePlan);
		return iac;
	}

	return {
		id: `pulumi-backed:${adapter.id}`,
		async preview(program: IacProgram): Promise<IacDiff> {
			const iac = await realizeFor(program);
			if (iac === undefined) {
				return {
					summary: `no stored plan for ${program.resourceId}; nothing to preview`,
					changes: 0,
				};
			}
			const diff = await adapter.preview(iac);
			return {
				summary: `pulumi preview ${program.resourceId} (${program.stackName})`,
				changes: diff.changes.length,
			};
		},
		async apply(program: IacProgram): Promise<IacOutputs> {
			const iac = await realizeFor(program);
			if (iac === undefined) {
				throw new Error(
					`pulumi-iac-provider: cannot apply ${program.resourceId}: no deployment.Planned fact for ${program.deploymentId}`,
				);
			}
			const result = await adapter.apply(iac);
			return toIacOutputs(result);
		},
		async destroy(program: IacProgram): Promise<void> {
			const iac = await realizeFor(program);
			if (iac === undefined) {
				return;
			}
			await adapter.destroy(iac);
		},
		async refresh(program: IacProgram): Promise<IacDriftReport> {
			const iac = await realizeFor(program);
			if (iac === undefined) {
				return { drift: false, observed: {} };
			}
			const report = await adapter.refresh(iac);
			return { drift: Boolean(report.drifted), observed: {} };
		},
	};
}
