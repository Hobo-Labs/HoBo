import { createHash, randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	type Connection,
	type Job,
	JobSchema,
	type Lease,
	type SandboxAllowance,
	type SandboxMeasuredUsage,
	SandboxMeasuredUsageSchema,
} from "@hobo/ci";
import type {
	GithubTransport,
	HostedRelayStore,
	IsolatedRunnerHost,
} from "@hobo/ci-gh-actions";
import { z } from "zod";
import type { IsolatedSandboxConfiguration } from "./isolated-sandbox.js";
import type { ProxySandboxCreate } from "./proxy-sandbox.js";
import {
	ProxyStartupError,
	type ProxyStartupFailure,
	type ProxyVmConfig,
} from "./sandbox-proxy-vm.js";

type RunnerLabel = NonNullable<Parameters<IsolatedRunnerHost["launch"]>[1]>;

export interface SandboxUsage {
	cpuMs: number;
	durationMs: number;
	memoryMb: number;
	vcpus: number;
	egressBytes: number;
	ingressBytes: number;
	creations: number;
	stoppedAt: number;
}
export interface IsolatedSandboxDriver {
	create(
		config: IsolatedSandboxConfiguration,
	): Promise<{ name: string; sessionId: string; expiresAt?: number }>;
	discover(name: string): Promise<{ sessionId: string }>;
	prepare(name: string, sessionId: string): Promise<void>;
	start(
		name: string,
		sessionId: string,
		jit: string,
	): Promise<{ cmdId: string }>;
	inspect(
		name: string,
		sessionId: string,
		commandId: string,
	): Promise<{
		commandId: string;
		exitCode: number | null;
		terminal?: boolean;
	}>;
	stop(name: string, sessionId: string): Promise<SandboxUsage>;
}
export interface SandboxProxyDriver {
	create(config: ProxySandboxCreate): Promise<{
		name: string;
		sessionId: string;
		origin: string;
		expiresAt: number;
	}>;
	start(
		name: string,
		sessionId: string,
		config: ProxyVmConfig,
	): Promise<{ commandId: string }>;
	bind(origin: string, token: string, guestSessionId: string): Promise<void>;
	discover(name: string): Promise<{ sessionId: string }>;
	stop(name: string, sessionId: string): Promise<SandboxUsage>;
}
export interface SandboxLeaseStore extends HostedRelayStore {
	/**
	 * The proxy session token for a lease, when the store derives it (the
	 * relay cache store: an HMAC of the lease id under a key from the config
	 * service). Without it the controller draws a random token.
	 */
	sandboxProxyToken?(leaseId: string): string;
	configureSandboxProxy(
		accountId: string,
		leaseId: string,
		proxySessionId: string,
		tokenSha256: string,
		expectedRevision: number,
	): Promise<void>;
	configureSandboxEgress(
		accountId: string,
		leaseId: string,
		sandboxId: string,
		maxBytes: number,
		expectedRevision: number,
	): Promise<void>;
	settleSandboxObserved(
		id: string,
		at: string,
		completedAt: string,
		observed: {
			state: string;
			runnerId: number;
			actualJobId: number;
			sandboxSessionId: string;
			sandboxCommandId: string;
			sandboxStage: string;
			proxySandboxSessionId?: string;
			proxySandboxCommandId?: string;
			proxySandboxStage?: string;
		},
		chargedMicros: number,
		unmet?: Job,
		usedAllowance?: SandboxAllowance,
	): Promise<Lease | undefined>;
}
export interface SandboxAuthority {
	revision: number;
	connection: Connection;
	configuration: Omit<IsolatedSandboxConfiguration, "name" | "timeoutMs">;
	maxEgressBytes: number;
	proxy?: {
		create: Omit<ProxySandboxCreate, "name" | "timeoutMs">;
		config: Omit<
			ProxyVmConfig,
			"leaseId" | "proxySessionId" | "quotaToken" | "proxyOrigin"
		>;
		extraMs: number;
	};
}

export type SandboxLaunchPhase =
	| "authorize"
	| "proxy_create"
	| "proxy_start"
	| "guest_create"
	| "configure_egress"
	| "proxy_bind"
	| "runner_prepare"
	| "reauthorize"
	| "jit_register"
	| "runner_start"
	| "cleanup";
export interface SandboxLaunchFailure {
	leaseId: string;
	phase: SandboxLaunchPhase;
	status?: number;
	proxyStartupReason?: ProxyStartupFailure;
}

/** The caller authorizes only leases reserved against an isolated Sandbox quote.
 * It must re-read current policy and verify that quote before returning authority. */
export function createSandboxController(options: {
	store: SandboxLeaseStore;
	github: GithubTransport;
	driver: IsolatedSandboxDriver;
	proxyDriver?: SandboxProxyDriver;
	authorize: (lease: Lease) => Promise<SandboxAuthority>;
	/** A trusted provider-usage ledger calculates the actual all-in charge. */
	charge: (
		lease: Lease,
		usage: SandboxUsage | undefined,
		proxyUsage?: SandboxUsage,
	) => Promise<{ paidMicros: number; usedAllowance?: SandboxAllowance }>;
	/** Assignment is distinct from billing; unknown is never asserted idle. */
	assignment: (
		lease: Lease,
	) => Promise<
		| { kind: "assigned"; jobId: number }
		| { kind: "unassigned" }
		| { kind: "unknown" }
	>;
	/** Return original demand only if GitHub confirms it is still queued. */
	unmet: (lease: Lease) => Promise<Job | undefined>;
	/** Receives only fixed phase names, lease identity and a sanitized HTTP status. */
	reportFailure?: (failure: SandboxLaunchFailure) => void;
	now?: (() => string) | undefined;
}) {
	const now = options.now ?? (() => new Date().toISOString());
	function report(
		leaseId: string,
		phase: SandboxLaunchPhase,
		status?: number,
		proxyStartupReason?: ProxyStartupFailure,
	) {
		// Refuse log injection if an invalid ID ever reaches this internal path.
		if (!/^[a-f0-9-]{36}$/.test(leaseId)) return;
		const failure: SandboxLaunchFailure = { leaseId, phase };
		const reason = z
			.enum([
				"marker",
				"read_config",
				"parse_config",
				"listen",
				"timeout",
				"process_exit",
			])
			.safeParse(proxyStartupReason);
		if (phase === "proxy_start" && reason.success)
			failure.proxyStartupReason = reason.data;
		if (
			status !== undefined &&
			Number.isInteger(status) &&
			status >= 100 &&
			status <= 599
		)
			failure.status = status;
		try {
			options.reportFailure?.(failure);
		} catch {
			// Telemetry must never interrupt cancellation or cleanup.
		}
	}
	// A lost JIT response may have created a runner. A positive, unique name
	// lookup lets us delete it; an empty lookup cannot prove that the request
	// will not complete later, so it must never release the reservation.
	async function recoverRunner(lease: Lease): Promise<number | undefined> {
		let runnerId: number | undefined;
		for (let page = 1; page <= 100; page++) {
			const response = await options.github.request(
				lease.installationId,
				`/repos/${lease.repository}/actions/runners?per_page=100&page=${page}`,
			);
			if (response.status !== 200) throw new Error("runner lookup failed");
			const data = z
				.object({
					runners: z
						.array(
							z.object({
								id: z.number().int().positive(),
								name: z.string(),
							}),
						)
						.max(100),
				})
				.parse(await response.json());
			for (const runner of data.runners) {
				if (runner.name !== lease.runnerName) continue;
				if (runnerId !== undefined) throw new Error("runner lookup ambiguous");
				runnerId = runner.id;
			}
			if (data.runners.length < 100) return runnerId;
		}
		throw new Error("runner lookup exceeds page limit");
	}
	async function uncertain(id: string, states: readonly string[]) {
		await options.store.transition(
			id,
			states,
			(lease) => {
				lease.state = "uncertain";
			},
			"ci.LeaseUncertain",
			now(),
		);
	}
	async function stopProxy(
		id: string,
		input: Lease,
	): Promise<Lease | undefined> {
		let lease = input;
		if (lease.sandboxPricing?.proxyVmRequired) {
			if (!options.proxyDriver || !lease.proxySandboxName) return;
			if (
				lease.proxySandboxStage === "creating" &&
				!lease.proxySandboxSessionId
			) {
				const discovered = await options.proxyDriver.discover(
					lease.proxySandboxName,
				);
				const recovered = await options.store.transition(
					id,
					[lease.state],
					(current) => {
						if (
							current.proxySandboxStage !== "creating" ||
							current.proxySandboxSessionId
						)
							throw new Error("proxy creation changed");
						current.proxySandboxSessionId = discovered.sessionId;
						current.proxySandboxStage = "created";
					},
					"ci.ProxyCreationRecovered",
					now(),
				);
				if (!recovered) return;
				lease = recovered;
			}
			if (!lease.proxySandboxSessionId) return;
			if (lease.proxySandboxStage !== "stopped") {
				if (lease.proxySandboxStage !== "stopping") {
					const before = lease.proxySandboxStage;
					const stopping = await options.store.transition(
						id,
						[lease.state],
						(current) => {
							if (
								current.proxySandboxStage !== before ||
								current.proxySandboxSessionId !== lease?.proxySandboxSessionId
							)
								throw new Error("proxy stop changed");
							current.proxySandboxStage = "stopping";
						},
						"ci.ProxyStopRequested",
						now(),
					);
					if (!stopping) return;
					lease = stopping;
				}
				const usage = await options.proxyDriver.stop(
					lease.proxySandboxName,
					lease.proxySandboxSessionId,
				);
				const evidence = create(SandboxMeasuredUsageSchema, {
					sessionId: lease.proxySandboxSessionId,
					cpuMs: usage.cpuMs,
					durationMs: usage.durationMs,
					memoryMb: usage.memoryMb,
					vcpus: usage.vcpus,
					egressBytes: usage.egressBytes,
					ingressBytes: usage.ingressBytes,
					stoppedAt: new Date(usage.stoppedAt).toISOString(),
				});
				const stopped = await options.store.transition(
					id,
					[lease.state],
					(current) => {
						if (
							current.proxySandboxStage !== "stopping" ||
							current.proxySandboxSessionId !== evidence.sessionId
						)
							throw new Error("proxy stop changed");
						current.proxyStoppedUsage = evidence;
						current.proxySandboxStage = "stopped";
					},
					"ci.ProxyStopped",
					now(),
				);
				if (!stopped) return;
				lease = stopped;
			}
		}
		return lease;
	}
	const controller = {
		/** Persist intent before every irreversible external operation. Ambiguous
		 * calls are never retried and remain reserved for reconciliation. */
		async launch(id: string, label: RunnerLabel = "hobo") {
			const initial = await options.store.get(id);
			if (initial?.state !== "reserved") return;
			let auth: SandboxAuthority;
			try {
				auth = await options.authorize(initial);
			} catch {
				report(id, "authorize");
				await options.store.cancelAndRequeue(
					id,
					create(JobSchema, {
						id: initial.jobId,
						runId: initial.originalRunId,
						runAttempt: initial.runAttempt,
						repositoryId: initial.repositoryId,
						installationId: initial.installationId,
						repository: initial.repository,
						labels: ["hobo"],
						action: "queued",
						isolatedRequired: true,
					}),
					now(),
				);
				return;
			}
			const name = `hobo-${id}`;
			const proxyName = `hobo-proxy-${id}`;
			if (auth.proxy && !options.proxyDriver)
				throw new Error("proxy driver unavailable");
			const planned = await options.store.transition(
				id,
				["reserved"],
				(lease) => {
					if (lease.sandboxName || lease.runnerId || lease.hostRunId)
						throw new Error("lease already launched");
					lease.sandboxName = name;
					lease.sandboxStage = auth.proxy ? "pending" : "creating";
					if (auth.proxy) {
						lease.proxySandboxName = proxyName;
						lease.proxySandboxStage = "creating";
					}
					lease.state = "dispatching";
				},
				"ci.DispatchRequested",
				now(),
				auth.revision,
			);
			if (!planned) return;
			let proxyToken = "";
			let proxyOrigin = "";
			let proxyDeadline = 0;
			let phase: SandboxLaunchPhase = auth.proxy
				? "proxy_create"
				: "guest_create";
			let status: number | undefined;
			try {
				if (auth.proxy && options.proxyDriver) {
					const proxy = await options.proxyDriver.create({
						...auth.proxy.create,
						name: proxyName,
						timeoutMs: planned.reservedMinutes * 60_000 + auth.proxy.extraMs,
					});
					if (
						proxy.name !== proxyName ||
						!proxy.sessionId ||
						!proxy.origin ||
						!Number.isSafeInteger(proxy.expiresAt)
					)
						throw new Error("proxy identity mismatch");
					proxyOrigin = proxy.origin;
					proxyDeadline = proxy.expiresAt;
					const createdProxy = await options.store.transition(
						id,
						["dispatching"],
						(lease) => {
							if (
								lease.proxySandboxName !== proxyName ||
								lease.proxySandboxSessionId ||
								lease.proxySandboxStage !== "creating"
							)
								throw new Error("proxy creation changed");
							lease.proxySandboxSessionId = proxy.sessionId;
							lease.proxySandboxStage = "created";
						},
						"ci.ProxyCreated",
						now(),
					);
					if (!createdProxy) throw new Error("proxy creation uncertain");
					proxyToken =
						options.store.sandboxProxyToken?.(id) ??
						randomBytes(32).toString("base64url");
					await options.store.configureSandboxProxy(
						createdProxy.accountId,
						id,
						proxy.sessionId,
						createHash("sha256").update(proxyToken).digest("hex"),
						auth.revision,
					);
					const startingProxy = await options.store.transition(
						id,
						["dispatching"],
						(lease) => {
							if (
								lease.proxySandboxSessionId !== proxy.sessionId ||
								lease.proxySandboxStage !== "created"
							)
								throw new Error("proxy identity changed");
							lease.proxySandboxStage = "starting";
						},
						"ci.ProxyStartRequested",
						now(),
						auth.revision,
					);
					if (!startingProxy) throw new Error("proxy start revoked");
					phase = "proxy_start";
					const command = await options.proxyDriver.start(
						proxyName,
						proxy.sessionId,
						{
							...auth.proxy.config,
							leaseId: id,
							proxySessionId: proxy.sessionId,
							quotaToken: proxyToken,
							proxyOrigin: proxy.origin,
						},
					);
					if (!command.commandId) throw new Error("proxy command missing");
					const runningProxy = await options.store.transition(
						id,
						["dispatching"],
						(lease) => {
							if (
								lease.proxySandboxSessionId !== proxy.sessionId ||
								lease.proxySandboxStage !== "starting" ||
								lease.proxySandboxCommandId
							)
								throw new Error("proxy start changed");
							lease.proxySandboxCommandId = command.commandId;
							lease.proxySandboxStage = "running";
						},
						"ci.ProxyStarted",
						now(),
					);
					if (!runningProxy) throw new Error("proxy start uncertain");
					const remaining = proxy.expiresAt - Date.parse(now());
					if (
						!Number.isFinite(remaining) ||
						remaining < planned.reservedMinutes * 60_000
					)
						throw new Error("proxy deadline insufficient");
					const guestIntent = await options.store.transition(
						id,
						["dispatching"],
						(lease) => {
							if (
								lease.sandboxStage !== "pending" ||
								lease.proxySandboxStage !== "running"
							)
								throw new Error("guest creation changed");
							lease.sandboxStage = "creating";
						},
						"ci.SandboxCreateRequested",
						now(),
						auth.revision,
					);
					if (!guestIntent) throw new Error("guest creation revoked");
				}
				const guestConfig = {
					...auth.configuration,
					name,
					timeoutMs: planned.reservedMinutes * 60_000,
				};
				if (proxyOrigin)
					guestConfig.forwardUrl = `${proxyOrigin}/sandbox/egress`;
				phase = "guest_create";
				const sandbox = await options.driver.create(guestConfig);
				if (sandbox.name !== name || !sandbox.sessionId)
					throw new Error("sandbox identity mismatch");
				if (
					auth.proxy &&
					(!sandbox.expiresAt || sandbox.expiresAt + 15000 > proxyDeadline)
				)
					throw new Error("proxy deadline cannot cover guest cleanup");
				const created = await options.store.transition(
					id,
					["dispatching"],
					(lease) => {
						if (lease.sandboxName !== name || lease.sandboxSessionId)
							throw new Error("sandbox state mismatch");
						lease.sandboxSessionId = sandbox.sessionId;
						lease.sandboxStage = "created";
						lease.state = "dispatched";
					},
					"ci.SandboxCreated",
					now(),
				);
				if (!created) throw new Error("sandbox reservation changed");
				phase = "configure_egress";
				await options.store.configureSandboxEgress(
					created.accountId,
					id,
					sandbox.sessionId,
					auth.maxEgressBytes,
					auth.revision,
				);
				phase = "proxy_bind";
				if (auth.proxy && options.proxyDriver)
					await options.proxyDriver.bind(
						proxyOrigin,
						proxyToken,
						sandbox.sessionId,
					);
				phase = "runner_prepare";
				await options.driver.prepare(name, sandbox.sessionId);
				phase = "reauthorize";
				const refreshed = await options.authorize(created);
				if (
					refreshed.connection.repositoryId !== created.repositoryId ||
					refreshed.connection.installationId !== created.installationId ||
					refreshed.connection.accountId !== created.accountId ||
					refreshed.connection.repository.toLowerCase() !==
						created.repository.toLowerCase()
				)
					throw new Error("sandbox binding changed");
				const registration = await options.store.transition(
					id,
					["dispatched"],
					(lease) => {
						if (lease.sandboxSessionId !== sandbox.sessionId || lease.runnerId)
							throw new Error("sandbox state mismatch");
						lease.sandboxStage = "registering";
						lease.state = "claiming";
					},
					"ci.RunnerClaimed",
					now(),
					refreshed.revision,
				);
				if (!registration) throw new Error("sandbox registration revoked");
				phase = "jit_register";
				const response = await options.github.request(
					registration.installationId,
					`/repos/${registration.repository}/actions/runners/generate-jitconfig`,
					"POST",
					JSON.stringify({
						name: registration.runnerName,
						runner_group_id: refreshed.connection.runnerGroupId,
						labels: [label],
						work_folder: "_hobo_work",
					}),
				);
				if (response.status !== 201) {
					status = response.status;
					throw new Error("runner registration failed");
				}
				const jit = z
					.object({
						encoded_jit_config: z.string().min(1),
						runner: z.object({
							id: z.number().int().positive(),
							name: z.literal(registration.runnerName),
						}),
					})
					.parse(await response.json());
				const registered = await options.store.transition(
					id,
					["claiming"],
					(lease) => {
						if (lease.runnerId || lease.sandboxSessionId !== sandbox.sessionId)
							throw new Error("sandbox state mismatch");
						lease.runnerId = jit.runner.id;
						lease.sandboxStage = "starting";
					},
					"ci.RunnerRegistered",
					now(),
				);
				if (!registered) throw new Error("sandbox registration changed");
				phase = "runner_start";
				const command = await options.driver.start(
					name,
					sandbox.sessionId,
					jit.encoded_jit_config,
				);
				if (!command.cmdId) throw new Error("sandbox command missing");
				const started = await options.store.transition(
					id,
					["claiming"],
					(lease) => {
						if (
							lease.runnerId !== jit.runner.id ||
							lease.sandboxSessionId !== sandbox.sessionId ||
							lease.sandboxCommandId
						)
							throw new Error("sandbox state mismatch");
						lease.sandboxCommandId = command.cmdId;
						lease.sandboxStage = "running";
						lease.state = "running";
					},
					"ci.SandboxRunnerStarted",
					now(),
				);
				if (!started) throw new Error("sandbox start became uncertain");
			} catch (error) {
				report(
					id,
					phase,
					status,
					error instanceof ProxyStartupError ? error.reason : undefined,
				);
				await uncertain(id, ["dispatching", "dispatched", "claiming"]);
				// Persist stop intent and usage; ambiguous outcomes remain reserved.
				await controller.reconcile(id, true).catch(() => report(id, "cleanup"));
			}
		},
		/** Stop guest first, then proxy, and persist both usage proofs before settlement. */
		async reconcile(id: string, forceStop = false) {
			let lease = await options.store.get(id);
			if (
				forceStop &&
				lease?.sandboxName &&
				["dispatching", "dispatched", "claiming"].includes(lease.state)
			) {
				// Fence launch before inspecting or stopping either VM. A create or
				// registration already in flight remains ambiguous until a positive
				// identity is recovered; a negative lookup never releases the lease.
				lease = await options.store.transition(
					id,
					[lease.state],
					(current) => {
						current.state = "uncertain";
					},
					"ci.LeaseUncertain",
					now(),
				);
			}
			if (
				!lease ||
				!["running", "uncertain"].includes(lease.state) ||
				!lease.sandboxName
			)
				return;
			if (!forceStop && lease.sandboxStage === "running") {
				if (!lease.sandboxCommandId || !lease.sandboxSessionId) return;
				const command = await options.driver.inspect(
					lease.sandboxName,
					lease.sandboxSessionId,
					lease.sandboxCommandId,
				);
				if (
					command.commandId !== lease.sandboxCommandId ||
					(command.exitCode === null && !command.terminal)
				)
					return;
			}
			if (lease.sandboxStage === "creating" && !lease.sandboxSessionId) {
				let discovered: { sessionId: string };
				try {
					discovered = await options.driver.discover(lease.sandboxName);
				} catch (error) {
					await stopProxy(id, lease);
					throw error;
				}
				const recovered = await options.store.transition(
					id,
					[lease.state],
					(current) => {
						if (
							current.sandboxStage !== "creating" ||
							current.sandboxSessionId ||
							current.runnerId
						)
							throw new Error("guest creation changed");
						current.sandboxSessionId = discovered.sessionId;
						current.sandboxStage = "created";
					},
					"ci.SandboxCreationRecovered",
					now(),
				);
				if (!recovered) return;
				lease = recovered;
			}
			if (
				lease.sandboxStage !== "pending" &&
				lease.sandboxStage !== "stopped"
			) {
				if (!lease.sandboxSessionId) return;
				if (lease.sandboxStage !== "stopping") {
					const before = lease.sandboxStage;
					const stopping = await options.store.transition(
						id,
						[lease.state],
						(current) => {
							if (
								current.sandboxSessionId !== lease?.sandboxSessionId ||
								current.sandboxStage !== before
							)
								throw new Error("guest stop changed");
							current.sandboxStopFromStage = before;
							current.sandboxStage = "stopping";
						},
						"ci.SandboxStopRequested",
						now(),
					);
					if (!stopping) return;
					lease = stopping;
				}
				const usage = await options.driver.stop(
					lease.sandboxName,
					lease.sandboxSessionId,
				);
				const evidence = create(SandboxMeasuredUsageSchema, {
					sessionId: lease.sandboxSessionId,
					cpuMs: usage.cpuMs,
					durationMs: usage.durationMs,
					memoryMb: usage.memoryMb,
					vcpus: usage.vcpus,
					egressBytes: usage.egressBytes,
					ingressBytes: usage.ingressBytes,
					stoppedAt: new Date(usage.stoppedAt).toISOString(),
				});
				const stopped = await options.store.transition(
					id,
					[lease.state],
					(current) => {
						if (
							current.sandboxStage !== "stopping" ||
							current.sandboxSessionId !== evidence.sessionId
						)
							throw new Error("guest stop changed");
						current.sandboxStoppedUsage = evidence;
						current.sandboxStage = "stopped";
					},
					"ci.SandboxStopped",
					now(),
				);
				if (!stopped) return;
				lease = stopped;
			}
			const stoppedProxy = await stopProxy(id, lease);
			if (!stoppedProxy) return;
			lease = stoppedProxy;
			if (!lease.runnerId && lease.sandboxStopFromStage === "registering") {
				const runnerId = await recoverRunner(lease);
				if (!runnerId) return;
				const recovered = await options.store.transition(
					id,
					[lease.state],
					(current) => {
						if (
							current.runnerId ||
							current.sandboxStage !== "stopped" ||
							current.sandboxStopFromStage !== "registering" ||
							current.sandboxCommandId
						)
							throw new Error("runner recovery changed");
						current.runnerId = runnerId;
					},
					"ci.RunnerRegistrationRecovered",
					now(),
				);
				if (!recovered) return;
				lease = recovered;
			}
			if (lease.runnerId && !lease.runnerDeletionConfirmed) {
				const removal = await options.github.request(
					lease.installationId,
					`/repos/${lease.repository}/actions/runners/${lease.runnerId}`,
					"DELETE",
				);
				if (![204, 404].includes(removal.status))
					throw new Error("runner cleanup unconfirmed");
				const deleted = await options.store.transition(
					id,
					[lease.state],
					(current) => {
						if (
							current.runnerId !== lease?.runnerId ||
							current.sandboxStage !== "stopped"
						)
							throw new Error("runner cleanup changed");
						current.runnerDeletionConfirmed = true;
					},
					"ci.RunnerDeleted",
					now(),
				);
				if (!deleted) return;
				lease = deleted;
			}
			// No runner command was started when registration failed. The guest is
			// stopped, so this registration could not have accepted a job.
			if (
				lease.runnerId &&
				(lease.sandboxStopFromStage !== "registering" || lease.actualJobId)
			) {
				const assignment = await options.assignment(lease);
				if (assignment.kind === "assigned") {
					if (
						!Number.isSafeInteger(assignment.jobId) ||
						assignment.jobId <= 0 ||
						(lease.actualJobId && lease.actualJobId !== assignment.jobId)
					)
						throw new Error("runner assignment mismatch");
					if (!lease.actualJobId) {
						const observed = await options.store.transition(
							id,
							[lease.state],
							(current) => {
								if (
									current.runnerId !== lease?.runnerId ||
									(current.actualJobId &&
										current.actualJobId !== assignment.jobId)
								)
									throw new Error("runner assignment changed");
								current.actualJobId = assignment.jobId;
							},
							"ci.JobObserved",
							now(),
						);
						if (!observed) return;
						lease = observed;
					}
				} else if (lease.actualJobId)
					throw new Error("runner assignment mismatch");
			}
			function usage(
				proof: SandboxMeasuredUsage | undefined,
			): SandboxUsage | undefined {
				if (!proof) return undefined;
				return {
					cpuMs: proof.cpuMs,
					durationMs: proof.durationMs,
					memoryMb: proof.memoryMb,
					vcpus: proof.vcpus,
					egressBytes: proof.egressBytes,
					ingressBytes: proof.ingressBytes,
					stoppedAt: Date.parse(proof.stoppedAt),
					creations: 1,
				};
			}
			const guestUsage = usage(lease.sandboxStoppedUsage),
				proxyUsage = usage(lease.proxyStoppedUsage);
			if (!guestUsage && lease.sandboxStage !== "pending") return;
			if (lease.sandboxPricing?.proxyVmRequired && !proxyUsage) return;
			const completedAt = Math.max(
				guestUsage?.stoppedAt ?? 0,
				proxyUsage?.stoppedAt ?? 0,
			);
			if (!completedAt) throw new Error("sandbox usage unavailable");
			const charged = await options.charge(lease, guestUsage, proxyUsage);
			if (!Number.isSafeInteger(charged.paidMicros) || charged.paidMicros < 0)
				throw new Error("invalid sandbox charge");
			const unmet = await options.unmet(lease);
			await options.store.settleSandboxObserved(
				id,
				now(),
				new Date(completedAt).toISOString(),
				{
					state: lease.state,
					runnerId: lease.runnerId,
					actualJobId: lease.actualJobId,
					sandboxSessionId: lease.sandboxSessionId,
					sandboxCommandId: lease.sandboxCommandId,
					sandboxStage: lease.sandboxStage,
					proxySandboxSessionId: lease.proxySandboxSessionId,
					proxySandboxCommandId: lease.proxySandboxCommandId,
					proxySandboxStage: lease.proxySandboxStage,
				},
				charged.paidMicros,
				unmet,
				charged.usedAllowance,
			);
		},
	};
	return controller;
}
