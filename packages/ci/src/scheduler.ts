import { clone, create, toJsonString } from "@bufbuild/protobuf";
import { stableHash } from "@hobo/dispatcher";
import {
	type Account,
	type Lease,
	type PipelineResult,
	PipelineResultSchema,
	PipelineSchema,
} from "./_generated/ci_pb.js";
import {
	BackendUnavailableError,
	executePipeline,
	type ParsedPipeline,
	type PipelineBackend,
	type PipelineExecutionScope,
	type PipelineUsageScope,
	supportsPipeline,
} from "./execution.js";
import type { LeaseStore } from "./store.js";

/** Backend bindings are scoped to the authenticated account's real execution contexts. */
export class PipelineScheduler {
	constructor(
		private readonly store: LeaseStore,
		private readonly accountId: string,
		private readonly bindings: ReadonlyMap<string, PipelineBackend>,
		private readonly now: () => string = () => new Date().toISOString(),
	) {}
	private usageScope(lease: Lease): PipelineUsageScope {
		return {
			leaseId: lease.id,
			pipelineId: lease.pipelineId,
			pipelineDigest: lease.pipelineDigest,
			provider: lease.provider,
			providerAccountId: lease.providerAccountId,
			externalOperationId: lease.externalOperationId,
		};
	}
	/** Read-only provider reconciliation remains available after cancellation, restart and deadlines. */
	async reconcile(leaseId: string): Promise<Lease | undefined> {
		const lease = this.store.get(leaseId);
		if (!lease?.pipelineId || lease.accountId !== this.accountId)
			throw new Error("pipeline account mismatch");
		if (
			lease.state === "completed" &&
			lease.usageProvenance === "provider-final"
		)
			return lease;
		const backend = this.bindings.get(lease.offerId);
		if (!backend?.observeFinalUsage)
			throw new Error("native final usage observer unavailable");
		const observed = await backend.observeFinalUsage(this.usageScope(lease));
		if (!observed) return undefined;
		return this.store.settlePipelineUsage(
			lease.id,
			observed,
			this.now(),
			lease.result,
		);
	}
	async execute(
		account: Account,
		pipeline: ParsedPipeline,
		options: { signal?: AbortSignal } = {},
	): Promise<PipelineResult> {
		if (account.id !== this.accountId || pipeline.accountId !== this.accountId)
			throw new Error("pipeline account mismatch");
		if (options.signal?.aborted)
			return create(PipelineResultSchema, {
				id: pipeline.id,
				status: "cancelled",
			});
		const digest = stableHash(
			JSON.parse(toJsonString(PipelineSchema, pipeline)),
		);
		const previous = this.store
			.all()
			.filter(
				(lease) =>
					lease.accountId === account.id && lease.pipelineId === pipeline.id,
			);
		if (previous.some((lease) => lease.pipelineDigest !== digest))
			throw new Error("pipeline id already used for different input");
		const cached = previous.find(
			(lease) => lease.state === "completed" && lease.result,
		);
		if (cached?.result) return cached.result;
		if (
			previous.some((lease) =>
				["reserved", "running", "uncertain"].includes(lease.state),
			)
		)
			throw new Error("pipeline already executing or awaiting reconciliation");
		const eligible = account.offers
			.filter((offer) => {
				const backend = this.bindings.get(offer.id);
				return (
					backend !== undefined &&
					backend.kind === (offer.backend || "gh-actions") &&
					supportsPipeline(backend, pipeline)
				);
			})
			.map((offer) => offer.id);
		while (eligible.length > 0) {
			const lease = this.store.reservePipeline(
				account,
				pipeline,
				digest,
				eligible,
				this.now(),
			);
			if (!lease) break;
			if (lease.state === "completed" && lease.result) return lease.result;
			if (lease.state !== "reserved")
				throw new Error(
					"pipeline already executing or awaiting reconciliation",
				);
			const backend = this.bindings.get(lease.offerId);
			if (!backend) throw new Error("bound backend disappeared");
			const started = this.store.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "running";
				},
				"ci.PipelineStarted",
				this.now(),
			);
			if (!started) throw new Error("pipeline reservation lost");
			const start = Date.parse(this.now());
			try {
				const scope: PipelineExecutionScope = {
					...this.usageScope(lease),
					authorizeAllocation: () => {
						if (
							!this.store.authorizePipelineStart(
								lease.id,
								account,
								pipeline,
								this.now(),
								"native-mutation",
							)
						)
							throw new Error(
								"durable policy revoked native mutation admission",
							);
					},
					recordExternalOperationId: (id) =>
						this.store.recordPipelineOperation(lease.id, id, this.now()),
				};
				const guardedBackend: PipelineBackend = {
					kind: backend.kind,
					capabilities: backend.capabilities,
					open: (input, signal) => {
						if (
							!this.store.authorizePipelineStart(
								lease.id,
								account,
								input,
								this.now(),
							)
						)
							throw new BackendUnavailableError(
								"durable policy revoked pipeline admission",
							);
						return backend.open(input, signal, scope);
					},
				};
				const result = await executePipeline(guardedBackend, pipeline, options);
				if (result.status === "uncertain") {
					this.store.transition(
						lease.id,
						["running"],
						(entry) => {
							entry.state = "uncertain";
							entry.result = result;
						},
						"ci.LeaseUncertain",
						this.now(),
					);
					return result;
				}
				const ended = this.now();
				this.store.recordPipelineResult(lease.id, result, ended);
				if (backend.observeFinalUsage) {
					const current = this.store.get(lease.id);
					if (!current) throw new Error("pipeline lease disappeared");
					const observed = await backend.observeFinalUsage(
						this.usageScope(current),
					);
					if (observed) {
						this.store.settlePipelineUsage(
							lease.id,
							observed,
							this.now(),
							result,
						);
						return result;
					}
					this.store.transition(
						lease.id,
						["running"],
						(entry) => {
							entry.state = "uncertain";
							entry.result = result;
						},
						"ci.UsagePending",
						this.now(),
					);
					const pending = clone(PipelineResultSchema, result);
					pending.status = "uncertain";
					pending.error = "native usage finality is pending";
					return pending;
				}
				const minutes = Math.max(
					1,
					Math.ceil((Date.parse(ended) - start) / 60000),
				);
				const settled = this.store.settle(
					lease.id,
					0,
					minutes,
					ended,
					undefined,
					ended,
					result,
				);
				if (settled?.state === "uncertain") {
					const pending = clone(PipelineResultSchema, result);
					pending.status = "uncertain";
					pending.error = "native financial usage finality is pending";
					return pending;
				}
				return result;
			} catch (error) {
				if (
					!(error instanceof BackendUnavailableError) ||
					this.store.get(lease.id)?.externalOperationId
				) {
					this.store.transition(
						lease.id,
						["running"],
						(entry) => {
							entry.state = "uncertain";
						},
						"ci.LeaseUncertain",
						this.now(),
					);
					throw error;
				}
				// Only definitive pre-allocation refusal permits another provider attempt.
				this.store.transition(
					lease.id,
					["running"],
					(entry) => {
						entry.state = "cancelled";
					},
					"ci.BackendRefused",
					this.now(),
				);
				eligible.splice(eligible.indexOf(lease.offerId), 1);
			}
		}
		return create(PipelineResultSchema, {
			id: pipeline.id,
			status: "blocked",
			error: "no eligible backend within budget and capacity",
		});
	}
}
