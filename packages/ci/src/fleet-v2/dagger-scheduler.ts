import { createHash } from "node:crypto";
import { toJsonString } from "@bufbuild/protobuf";
import { stableHash } from "@hobo/dispatcher";
import {
	type Account,
	type PipelineResult,
	PipelineSchema,
} from "../_generated/ci_pb.js";
import type { ExecutionClaim } from "../_generated/fleet_v2_pb.js";
import {
	BackendUnavailableError,
	type ParsedPipeline,
	type PipelineBackend,
} from "../execution.js";
import { PipelineScheduler } from "../scheduler.js";
import type { LeaseStore } from "../store.js";
import type { ParsedDaggerStartInput } from "./parse.js";
import type { StrictFleetStore } from "./strict-store.js";

export interface BoundDaggerBackend extends PipelineBackend {
	readonly kind: "dagger";
	readonly endpoint: string;
}

export type StrictDaggerResult =
	| { kind: "existing"; claim: ExecutionClaim }
	| { kind: "finished"; claim: ExecutionClaim; result: PipelineResult };

export function normalizeDaggerEndpoint(endpoint: string): string {
	const url = new URL(endpoint);
	if (
		!["https:", "tcp:", "unix:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol === "unix:"
			? !url.pathname.startsWith("/") || !!url.host
			: !url.hostname)
	)
		throw new Error("invalid Dagger engine endpoint");
	return url.href;
}

export function daggerEndpointHash(endpoint: string): string {
	return createHash("sha256")
		.update(normalizeDaggerEndpoint(endpoint))
		.digest("hex");
}

export function daggerPipelineDigest(pipeline: ParsedPipeline): string {
	return stableHash(JSON.parse(toJsonString(PipelineSchema, pipeline)));
}

export class StrictDaggerScheduler {
	constructor(
		private readonly fleet: StrictFleetStore,
		private readonly leases: LeaseStore,
		private readonly accountId: string,
		private readonly backend: BoundDaggerBackend,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}

	async execute(
		account: Account,
		pipeline: ParsedPipeline,
		input: ParsedDaggerStartInput,
		options: { signal?: AbortSignal } = {},
	): Promise<StrictDaggerResult> {
		options.signal?.throwIfAborted();
		if (input.key.key.case !== "daggerPipeline")
			throw new Error("Dagger pipeline key required");
		const key = input.key.key.value;
		const digest = daggerPipelineDigest(pipeline);
		if (
			account.id !== this.accountId ||
			pipeline.accountId !== this.accountId ||
			key.accountId !== this.accountId ||
			key.pipelineId !== pipeline.id ||
			key.pipelineDigest !== digest ||
			input.engineEndpointHash !== daggerEndpointHash(this.backend.endpoint) ||
			this.backend.kind !== "dagger" ||
			account.offers.filter(
				(offer) => offer.id === input.offerId && offer.backend === "dagger",
			).length !== 1
		)
			throw new Error("pipeline does not match the bound Dagger claim");
		const started = await this.fleet.startDagger(input);
		if (!started.created) return { kind: "existing", claim: started.claim };
		let attempted = false;
		const backend = this.backend;
		const fleet = this.fleet;
		const guarded: PipelineBackend = {
			kind: backend.kind,
			capabilities: backend.capabilities,
			async open(candidate, signal, scope) {
				if (!scope)
					throw new BackendUnavailableError(
						"pipeline execution scope is required",
					);
				try {
					await fleet.assertDaggerStartAllowed(input);
				} catch {
					throw new BackendUnavailableError(
						"strict Dagger admission is no longer valid",
					);
				}
				attempted = true;
				try {
					const session = await backend.open(candidate, signal, scope);
					let first = true;
					return {
						async run(step, runSignal) {
							if (first) {
								await fleet.assertDaggerStartAllowed(input);
								scope.authorizeAllocation();
								first = false;
							}
							return session.run(step, runSignal);
						},
						artifact: (path, artifactSignal) =>
							session.artifact(path, artifactSignal),
						close: (reason) => session.close(reason),
					};
				} catch (error) {
					if (error instanceof BackendUnavailableError) attempted = false;
					throw error;
				}
			},
		};
		const observeFinalUsage = backend.observeFinalUsage?.bind(backend);
		if (observeFinalUsage) guarded.observeFinalUsage = observeFinalUsage;
		const scheduler = new PipelineScheduler(
			this.leases,
			this.accountId,
			new Map([[input.offerId, guarded]]),
			this.now,
		);
		let result: PipelineResult;
		try {
			result = await scheduler.execute(account, pipeline, options);
		} catch (error) {
			await this.fleet.completeExecution({
				claimId: input.claimId,
				state: attempted ? "uncertain" : "failed",
				teardownConfirmed: !attempted,
			});
			throw error;
		}
		if (!attempted && result.status === "succeeded") {
			await this.fleet.completeExecution({
				claimId: input.claimId,
				state: "failed",
				teardownConfirmed: true,
			});
			throw new Error("pipeline result predates the strict Dagger claim");
		}
		const state =
			result.status === "uncertain"
				? "uncertain"
				: result.status === "succeeded"
					? "completed"
					: result.status === "cancelled" || result.status === "timed_out"
						? "cancelled"
						: "failed";
		const settled = await this.fleet.completeExecution({
			claimId: input.claimId,
			state,
			teardownConfirmed: result.status !== "uncertain",
		});
		return { kind: "finished", claim: settled.claim, result };
	}
}
