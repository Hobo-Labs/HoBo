import { toJsonString } from "@bufbuild/protobuf";
import type { CiEvent } from "@hobo/ci";
import { z } from "zod";
import { JitBootstrapResponseSchema } from "./_generated/jit_bootstrap_response_pb.js";
import { type GithubTransport, getJob } from "./github.js";
import {
	HostedRelay,
	type HostedRelayStore,
	type IsolatedRunnerHost,
} from "./hosted-relay.js";
import type { IdentityVerifier } from "./oidc.js";

/** The inbox stores only signature-verified GitHub delivery bytes. */
export interface HostedInboxStore extends HostedRelayStore {
	ready(): Promise<boolean>;
	latestLeaseIntents(ids: readonly string[]): Promise<CiEvent[]>;
	acceptWebhook(input: {
		deliveryId: string;
		event: string;
		installationId: number;
		repositoryId: number;
		rawBody: Uint8Array;
		receivedAt: string;
	}): Promise<{ duplicate: boolean }>;
	acceptIgnoredWebhook(input: {
		deliveryId: string;
		event: string;
		installationId: number;
		repositoryId: number;
		rawBody: Uint8Array;
		receivedAt: string;
	}): Promise<{ duplicate: boolean }>;
	claimWebhook(
		now: string,
		leaseMs: number,
	): Promise<
		| undefined
		| {
				deliveryId: string;
				event: string;
				rawBody: Uint8Array;
				token: string;
		  }
	>;
	ackWebhook(deliveryId: string, token: string): Promise<boolean>;
	failWebhook(
		deliveryId: string,
		token: string,
		now: string,
	): Promise<"retry" | "quarantined" | "stale">;
}
const DeliveryIdentity = z.object({
	installation: z.object({
		id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	}),
	repository: z.object({
		id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		full_name: z.string().min(3),
	}),
});

/** Public API and bounded worker share the durable inbox and lease authority. */
export function createHostedRelayRuntime(options: {
	store: HostedInboxStore;
	github: GithubTransport;
	identity: IdentityVerifier;
	webhookSecret: string;
	isolatedHost?: IsolatedRunnerHost;
	denyUnisolated?: boolean;
	/** Recovery-only access never admits work or starts a runner. */
	isolatedRecoveryHost?: Pick<IsolatedRunnerHost, "reconcile">;
	control: (request: Request) => Promise<Response | undefined>;
	now?: () => string;
}) {
	const now = options.now ?? (() => new Date().toISOString());
	async function relay() {
		const state = await options.store.configuration();
		if (!state?.configuration) throw new Error("configuration unavailable");
		const relayOptions: ConstructorParameters<typeof HostedRelay>[0] = {
			config: state.configuration,
			store: options.store,
			github: options.github,
			identity: options.identity,
			webhookSecret: options.webhookSecret,
			now,
		};
		if (options.denyUnisolated) relayOptions.denyUnisolated = true;
		if (options.isolatedHost) relayOptions.isolatedHost = options.isolatedHost;
		return new HostedRelay(relayOptions);
	}
	return {
		async ingestWebhook(input: {
			deliveryId: string;
			event: "workflow_job" | "workflow_run";
			rawBody: Uint8Array;
			receivedAt: string;
		}) {
			const identity = DeliveryIdentity.parse(
				JSON.parse(Buffer.from(input.rawBody).toString("utf8")),
			);
			const state = await options.store.configuration();
			if (!state?.configuration) throw new Error("configuration unavailable");
			if (
				!state.configuration.connections.some(
					(connection) =>
						connection.installationId === identity.installation.id &&
						connection.repositoryId === identity.repository.id &&
						connection.repository.toLowerCase() ===
							identity.repository.full_name.toLowerCase(),
				)
			) {
				await options.store.acceptIgnoredWebhook({
					...input,
					installationId: identity.installation.id,
					repositoryId: identity.repository.id,
				});
				return "ignored" as const;
			}
			const result = await options.store.acceptWebhook({
				...input,
				installationId: identity.installation.id,
				repositoryId: identity.repository.id,
			});
			return result.duplicate ? ("duplicate" as const) : ("accepted" as const);
		},
		async claim(id: string, token: string): Promise<Response> {
			const result = await (await relay()).claim(id, token);
			return new Response(toJsonString(JitBootstrapResponseSchema, result), {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
				},
			});
		},
		control: options.control,
		async ready() {
			return (
				(await options.store.ready()) &&
				(await options.store.configuration())?.configuration !== undefined
			);
		},
		/** Process a bounded inbox batch, then drain and inspect known leases. */
		async tick(tickOptions: { maxDeliveries?: number } = {}) {
			const limit = tickOptions.maxDeliveries ?? 10;
			if (!Number.isInteger(limit) || limit < 0 || limit > 50)
				throw new Error("invalid delivery batch size");
			// A function can die after committing intent and before recording the
			// external response. Old in-flight intent becomes uncertain, never retried.
			const leases = await options.store.activeLeases();
			const events = await options.store.latestLeaseIntents(
				leases
					.filter(
						(lease) =>
							lease.state === "dispatching" ||
							lease.state === "claiming" ||
							(lease.state === "dispatched" &&
								lease.provider === "vercel" &&
								lease.sandboxName),
					)
					.map((lease) => lease.id),
			);
			for (const lease of leases) {
				const sandbox =
					(lease.provider === "vercel" ||
						lease.provider === "kubernetes" ||
						lease.provider === "hobo-box-worker") &&
					!!lease.sandboxName;
				if (
					lease.state !== "dispatching" &&
					lease.state !== "claiming" &&
					!(sandbox && lease.state === "dispatched")
				)
					continue;
				const kind =
					lease.state === "dispatching"
						? "ci.DispatchRequested"
						: lease.state === "claiming"
							? "ci.RunnerClaimed"
							: "ci.SandboxCreated";
				// A Vercel Function can run for up to 800 seconds. Wait longer
				// before treating its in-flight Sandbox operation as abandoned.
				const cutoff = Date.parse(now()) - (sandbox ? 1_020_000 : 120_000);
				const intent = [...events]
					.reverse()
					.find((event) => event.leaseId === lease.id && event.type === kind);
				if (
					!intent ||
					!Number.isFinite(Date.parse(intent.at)) ||
					Date.parse(intent.at) > cutoff
				)
					continue;
				await options.store.transition(
					lease.id,
					[lease.state],
					(entry) => {
						entry.state = "uncertain";
					},
					"ci.LeaseUncertain",
					now(),
				);
			}
			let deliveryFailed = false;
			for (let processed = 0; processed < limit; processed++) {
				const claim = await options.store.claimWebhook(now(), 120_000);
				if (!claim) break;
				try {
					await (await relay()).processWebhook(
						Buffer.from(claim.rawBody),
						claim.event,
					);
					if (!(await options.store.ackWebhook(claim.deliveryId, claim.token)))
						throw new Error("inbox claim lost");
				} catch {
					// Retain failed evidence with a backoff (and eventual quarantine), so
					// a poison delivery cannot block other accounts in the shared inbox.
					if (
						(await options.store.failWebhook(
							claim.deliveryId,
							claim.token,
							now(),
						)) === "stale"
					)
						throw new Error("inbox claim lost");
					deliveryFailed = true;
				}
			}
			const controller = await relay();
			for (const lease of await options.store.activeLeases()) {
				if (
					!["running", "dispatched", "uncertain"].includes(lease.state) &&
					!(
						!options.isolatedHost &&
						options.isolatedRecoveryHost &&
						lease.provider === "vercel" &&
						!!lease.sandboxName &&
						["dispatching", "claiming"].includes(lease.state)
					)
				)
					continue;
				try {
					if (
						(lease.provider === "vercel" ||
							lease.provider === "kubernetes" ||
							lease.provider === "hobo-box-worker") &&
						lease.sandboxName
					) {
						const host = options.isolatedHost ?? options.isolatedRecoveryHost;
						if (host) {
							let assignedJobCompleted = false;
							if (
								options.isolatedHost &&
								lease.state !== "uncertain" &&
								lease.actualJobId > 0 &&
								lease.runnerName
							) {
								try {
									const job = await getJob(
										options.github,
										lease.installationId,
										lease.repository,
										lease.actualJobId,
									);
									assignedJobCompleted =
										job.id === lease.actualJobId &&
										job.status === "completed" &&
										job.runner_name === lease.runnerName;
								} catch {
									// Failed or ambiguous GitHub reads cannot authorize a stop.
								}
							}
							await host.reconcile(
								lease.id,
								!options.isolatedHost ||
									lease.state === "uncertain" ||
									assignedJobCompleted,
							);
						}
						continue;
					}
					if (lease.hostRunId > 0)
						await controller.reconcile(lease.id, lease.hostRunId);
					else await controller.discover(lease.id);
				} catch {
					/* Retain ambiguous reservations until a later verified reconciliation. */
				}
			}
			await controller.dispatchPending();
			if (deliveryFailed)
				throw new Error("one or more inbox deliveries failed");
		},
	};
}
