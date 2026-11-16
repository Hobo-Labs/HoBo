import {
	CLOUD_EVENTS,
	collectStream,
	type DeploymentPlan,
	type IacDiff,
	type IacDriftReport,
	type IacOutputs,
	type IacProgram,
	type IacProvider,
	type ResourcePlan,
} from "@hobo/cloud";
import type {
	CloudProvider,
	EventEnvelope,
	EventStore,
	IacProgramDocument,
} from "@hobo/core";
import { createPulumiAutomationAdapter } from "@hobo/iac-pulumi";
import { isJsonString, type JsonObject, type JsonValue } from "./json.js";

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
	// Estate discovery seam (optional — spy/test adapters may omit it): the full
	// per-resource-stack state the adapter's backend holds, `{ [stackKey]:
	// { resources } }`. Drives `hobo drift`/`hobo import`; the real CLI engine
	// fails closed with a typed PulumiEngineUnavailableError when the pulumi
	// binary is missing.
	snapshotState?(): JsonObject;
}

export interface PulumiBackedIacProviderOptions {
	// The durable event store the Orchestrator writes `deployment.Planned` to. The
	// bridge reads the stored DeploymentPlan back to resolve each resource's plan.
	readonly store: EventStore;
	// The real CloudProviders whose `realize()` lowers a ResourcePlan to a shape-B
	// program. Keyed by `provider.id` (matches the shape-A program's `provider`).
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
			// SAFETY: assertion required at this I/O or test boundary.
			plan = (event.data as { plan: DeploymentPlan }).plan;
		}
	}
	return plan;
}

// Flatten the adapter's per-resource-stack apply result into the kernel's flat
// `IacOutputs` (Record<string, string>): the resolved stack outputs plus the
// resource/output bindings the adapter publishes (both already string-valued).
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
		// SAFETY: the in-memory automation adapter implements PulumiAutomationAdapter.
		adapter = createPulumiAutomationAdapter() as PulumiAutomationAdapter;
	}
	const providersById = new Map<string, CloudProvider>(
		options.providers.map((provider) => [provider.id, provider]),
	);

	// Resolve the shape-A execution descriptor into the shape-B declarative program
	// the real adapter consumes: read the stored plan, find this resource's real
	// ResourcePlan, and lower it via the REAL provider.realize(). Thread the
	// shape-A deploymentId so the adapter's per-resource stack key is stable across
	// preview/apply/destroy for this resource.
	//
	// Returns `undefined` when the plan/resource cannot be resolved from the store.
	// That only happens on a teardown against a store that never observed this
	// deployment's `deployment.Planned` fact (e.g. a fresh-process `hobo down`
	// whose in-memory Pulumi state is likewise empty) — there is genuinely nothing
	// to realize, so the mutating paths no-op rather than fabricate a plan. The
	// apply path REQUIRES a resolved plan and rejects `undefined`.
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
		const resourcePlan: ResourcePlan = {
			...resource,
			deploymentId: program.deploymentId,
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
