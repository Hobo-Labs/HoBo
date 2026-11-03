import { create } from "@bufbuild/protobuf";
import {
	effectiveCiAccount,
	type Job,
	JobSchema,
	type Lease,
	parseCiPolicy,
	route,
} from "@hobo/ci";
import { z } from "zod";
import { runnerDownloadFor } from "../bootstrap.js";
import { type GithubTransport, getJob } from "../github.js";
import type { HostedRelayStore, IsolatedRunnerHost } from "../hosted-relay.js";
import { isIsolatedContainerOffer } from "../isolated-backend.js";
import type { DockerDriver } from "./docker-driver.js";

const JIT_PATH = "/tmp/hobo-ci-jit";

/** Start the runner with its JIT config delivered over stdin to a 0600 file
 * and handed to the runner via env, so the credential never appears in argv. */
export async function startRunner(
	docker: DockerDriver,
	name: string,
	containerId: string,
	jitConfig: string,
): Promise<void> {
	// The JIT config is a runner credential: deliver it over stdin into a
	// 0600 file and hand it to the runner via env, never via argv (ps).
	if (!docker.writeSecret)
		throw new Error("docker driver cannot deliver secrets");
	await docker.writeSecret(name, containerId, JIT_PATH, jitConfig);
	const runJob = docker.execDetached ?? docker.exec;
	const prep = await runJob(name, containerId, [
		"sh",
		"-ec",
		`set -eu
if [ -x /opt/actions-runner/run.sh ]; then
  cd /opt/actions-runner
else
  mkdir -m 700 /tmp/hobo-ci && cd /tmp/hobo-ci
  curl -fsSL "$HOBO_CI_RUNNER_URL" -o runner.tar.gz
  printf '%s  runner.tar.gz\\n' "$HOBO_CI_RUNNER_SHA256" | sha256sum --check --status
  mkdir -m 700 runner && tar -xzf runner.tar.gz -C runner
  cd runner
fi
ACTIONS_RUNNER_INPUT_JITCONFIG="$(cat ${JIT_PATH})"
rm -f ${JIT_PATH}
export ACTIONS_RUNNER_INPUT_JITCONFIG
exec ./run.sh`,
	]);
	if (prep.exitCode !== 0) throw new Error("runner start failed");
}

const jitResponse = z.object({
	encoded_jit_config: z.string().min(1),
	runner: z.object({ id: z.number().int().positive() }),
});

function requeueJob(lease: {
	jobId: number;
	originalRunId: number;
	runAttempt: number;
	repositoryId: number;
	installationId: number;
	repository: string;
}) {
	return create(JobSchema, {
		id: lease.jobId,
		runId: lease.originalRunId,
		runAttempt: lease.runAttempt,
		repositoryId: lease.repositoryId,
		installationId: lease.installationId,
		repository: lease.repository,
		labels: ["hobo"],
		action: "queued",
		isolatedRequired: true,
	});
}

export type IsolatedContainerController = {
	host: IsolatedRunnerHost;
	ready: () => Promise<boolean>;
	/** Create one idle container ahead of demand so the next launch skips `docker create`/`start`. */
	prewarm: () => Promise<void>;
	/** Remove the idle pre-warmed container (daemon shutdown). */
	discardWarm: () => Promise<void>;
};

const LIVE_CONTAINER_STATES = new Set([
	"dispatching",
	"dispatched",
	"claiming",
	"running",
	"uncertain",
]);

/** What the box worker needs from a lease store; `PostgresCiStore` and `SqliteCiStore` both qualify. */
export interface IsolatedWorkerStore extends HostedRelayStore {
	settle(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet?: Job,
	): Promise<Lease | undefined>;
}

export function createIsolatedContainerController(options: {
	store: IsolatedWorkerStore;
	github: GithubTransport;
	publicOrigin: string;
	docker: DockerDriver;
	workerAccountId: string;
	workerImage: string;
	workerMemoryMb?: number;
	now?: () => string;
	/** Requeue uncertain leases that never got a container session. */
	uncertainWithoutContainerRecoveryMs?: number;
	/** Max job containers alive at once on this host (default 1: the old serial behaviour). */
	slots?: number;
	/** Shared volumes mounted into every job container (pnpm store). */
	volumes?: readonly Readonly<{ source: string; target: string }>[];
	/** Extra non-secret env for job containers (e.g. npm_config_store_dir). */
	containerEnv?: Readonly<Record<string, string>>;
}): IsolatedContainerController {
	const now = options.now ?? (() => new Date().toISOString());
	const uncertainWithoutContainerRecoveryMs =
		options.uncertainWithoutContainerRecoveryMs ?? 5 * 60_000;
	const workerMemoryMb = options.workerMemoryMb ?? 8192;
	const slots = options.slots ?? 1;
	if (!Number.isInteger(slots) || slots < 1 || slots > 8)
		throw new Error("invalid worker slots");
	const runner = runnerDownloadFor(process.arch);
	const containerSpec = (name: string, timeoutMs: number) => ({
		name,
		image: options.workerImage,
		timeoutMs,
		runAsUser: "1000:1000",
		memoryMb: workerMemoryMb,
		volumes: options.volumes ?? [],
		env: {
			...options.containerEnv,
			HOBO_CI_RELAY_ORIGIN: options.publicOrigin,
			HOBO_CI_RUNNER_SHA256: runner.sha256,
			HOBO_CI_RUNNER_URL: runner.url,
		},
		command: ["sleep", "infinity"],
	});
	let warm: Readonly<{ name: string; containerId: string }> | undefined;
	let warming: Promise<void> | undefined;
	const liveContainers = async (except: string) =>
		(await options.store.activeLeases()).filter(
			(lease) =>
				lease.id !== except &&
				(lease.provider === "kubernetes" ||
					lease.provider === "hobo-box-worker") &&
				LIVE_CONTAINER_STATES.has(lease.state),
		).length;
	const prewarm = async () => {
		if (warm || warming || !options.docker.rename) return;
		warming = (async () => {
			const name = `hobo-warm-${Date.now().toString(36)}`;
			const handle = await options.docker.create(
				containerSpec(name, 6 * 60 * 60_000),
			);
			try {
				await options.docker.start(name, handle.containerId);
				warm = handle;
			} catch {
				await options.docker
					.remove(name, handle.containerId)
					.catch(() => undefined);
			}
		})().finally(() => {
			warming = undefined;
		});
		await warming;
	};
	const authorize = async (leaseId: string) => {
		const lease = await options.store.get(leaseId);
		if (!lease?.state || lease.state === "completed")
			throw new Error("lease missing");
		const snapshot = await options.store.policySnapshot();
		const configuration = snapshot.state?.configuration;
		if (!configuration || !snapshot.state)
			throw new Error("configuration unavailable");
		const connection = configuration.connections.find(
			(entry) =>
				entry.accountId === lease.accountId &&
				entry.repositoryId === lease.repositoryId &&
				entry.installationId === lease.installationId &&
				entry.repository.toLowerCase() === lease.repository.toLowerCase(),
		);
		const original = configuration.accounts.find(
			(entry) => entry.id === lease.accountId,
		);
		if (
			!connection?.isolatedOnly ||
			!connection.acceptAllMatchingRepositoryJobs ||
			!connection.publicRepositoryAcknowledged ||
			connection.allowAllPullRequests ||
			connection.allowedEvents.length !== 0 ||
			connection.allowedRefs.length !== 0 ||
			!original
		)
			throw new Error("worker binding unavailable");
		const desired = snapshot.policies.find(
			(entry) => entry.accountId === lease.accountId,
		);
		const account = desired
			? effectiveCiAccount(original, parseCiPolicy(desired.bodyJson))
			: original;
		const offer = account.offers.find((entry) => entry.id === lease.offerId);
		if (
			!offer ||
			!isIsolatedContainerOffer(offer) ||
			offer.providerAccountId !== options.workerAccountId ||
			offer.priceMicrosPerMinute !== 0 ||
			offer.freeMinutes !== 0 ||
			account.maxRuntimeMinutes + account.startupMinutes !==
				lease.reservedMinutes
		)
			throw new Error("worker offer changed");
		const decision = route(
			{
				...account,
				offers: account.offers.filter((entry) =>
					isIsolatedContainerOffer(entry),
				),
			},
			(await options.store.accountLeases(lease.accountId)).filter(
				(entry) => entry.id !== lease.id,
			),
			now(),
		);
		if (
			!decision ||
			decision.offer.id !== offer.id ||
			decision.paidMicros > lease.reservedPaidMicros
		)
			throw new Error("worker quote unavailable or changed");
		return { revision: snapshot.state.revision, connection, lease };
	};

	const host: IsolatedRunnerHost = {
		async launch(id: string) {
			const initial = await options.store.get(id);
			if (initial?.state !== "reserved") return;
			// Slot full: leave the lease reserved; the next relay tick retries it.
			if ((await liveContainers(id)) >= slots) return;
			let auth: Awaited<ReturnType<typeof authorize>>;
			try {
				auth = await authorize(id);
			} catch {
				await options.store.abortIsolatedAndRequeue(
					id,
					requeueJob(initial),
					now(),
				);
				return;
			}
			const name = `hobo-${id}`;
			const planned = await options.store.transition(
				id,
				["reserved"],
				(lease) => {
					if (lease.sandboxName || lease.runnerId || lease.hostRunId)
						throw new Error("lease already launched");
					lease.sandboxName = name;
					lease.sandboxStage = "creating";
					lease.state = "dispatching";
				},
				"ci.DispatchRequested",
				now(),
				auth.revision,
			);
			if (!planned) return;
			let containerId = "";
			try {
				const spare = warm;
				warm = undefined;
				if (spare && options.docker.rename) {
					await options.docker.rename(spare.containerId, name);
					containerId = spare.containerId;
				} else {
					const handle = await options.docker.create(
						containerSpec(name, planned.reservedMinutes * 60_000),
					);
					if (handle.name !== name)
						throw new Error("container identity mismatch");
					containerId = handle.containerId;
					await options.docker.start(name, containerId);
				}
				const created = await options.store.transition(
					id,
					["dispatching"],
					(lease) => {
						if (lease.sandboxName !== name || lease.sandboxSessionId)
							throw new Error("container state mismatch");
						lease.sandboxSessionId = containerId;
						lease.sandboxStage = "created";
						lease.state = "dispatched";
					},
					"ci.SandboxCreated",
					now(),
				);
				if (!created) throw new Error("reservation changed");
				await options.store.transition(
					id,
					["dispatched"],
					(lease) => {
						if (lease.sandboxSessionId !== containerId || lease.runnerId)
							throw new Error("container state mismatch");
						lease.sandboxStage = "registering";
						lease.state = "claiming";
					},
					"ci.RunnerClaimed",
					now(),
					auth.revision,
				);
				const response = await options.github.request(
					created.installationId,
					`/repos/${created.repository}/actions/runners/generate-jitconfig`,
					"POST",
					JSON.stringify({
						name: created.runnerName,
						runner_group_id: auth.connection.runnerGroupId,
						labels: ["hobo"],
						work_folder: "_hobo_work",
					}),
				);
				if (response.status !== 201)
					throw new Error("runner registration failed");
				const jit = jitResponse.parse(await response.json());
				const registered = await options.store.transition(
					id,
					["claiming"],
					(lease) => {
						if (lease.sandboxSessionId !== containerId)
							throw new Error("container changed");
						lease.runnerId = jit.runner.id;
						lease.sandboxStage = "running";
						lease.state = "running";
					},
					"ci.RunnerRegistered",
					now(),
				);
				if (!registered) throw new Error("registration revoked");
				await startRunner(
					options.docker,
					name,
					containerId,
					jit.encoded_jit_config,
				);
				// Get the next container ready while this job runs.
				if ((await liveContainers("")) < slots)
					void prewarm().catch(() => undefined);
			} catch {
				if (containerId) {
					try {
						await options.docker.stop(name, containerId);
						await options.docker.remove(name, containerId);
					} catch {
						/* recovery will retry stop */
					}
				}
				await options.store.abortIsolatedAndRequeue(
					id,
					requeueJob(planned),
					now(),
				);
			}
		},
		async reconcile(id: string, forceStop?: boolean) {
			const lease = await options.store.get(id);
			if (!lease) return;
			if (!lease.sandboxSessionId || !lease.sandboxName) {
				if (lease.state === "uncertain") {
					const ageMs = Date.parse(now()) - Date.parse(lease.createdAt);
					if (ageMs >= uncertainWithoutContainerRecoveryMs) {
						await options.store.abortIsolatedAndRequeue(
							id,
							requeueJob(lease),
							now(),
						);
					}
				}
				return;
			}
			let running = false;
			try {
				running = await options.docker.isRunning(
					lease.sandboxName,
					lease.sandboxSessionId,
				);
			} catch {
				// An inspect error (timeout under load, daemon hiccup) is not proof the
				// job died: stopping here kills a live runner. Retry on the next tick.
				if (!forceStop) return;
				running = false;
			}
			if (!forceStop && lease.state === "running" && running) return;
			const deadWhileRunning =
				!forceStop && lease.state === "running" && !running;
			if (deadWhileRunning) {
				await options.store.abortIsolatedAndRequeue(
					id,
					requeueJob(lease),
					now(),
				);
			}
			try {
				if (running) {
					await options.docker.stop(lease.sandboxName, lease.sandboxSessionId);
				}
				await options.docker.remove(lease.sandboxName, lease.sandboxSessionId);
			} catch {
				if (!deadWhileRunning && !forceStop)
					throw new Error("container stop uncertain");
			}
			if (deadWhileRunning) return;
			if (!forceStop) return;
			const original = await getJob(
				options.github,
				lease.installationId,
				lease.repository,
				lease.jobId,
			);
			// Match hosted relay settlement: if the reserved job is still queued
			// (including when GitHub assigned a different job to this runner), re-queue it.
			const unmet =
				original.status === "queued" ? requeueJob(lease) : undefined;
			await options.store.settle(
				id,
				0,
				Math.max(
					1,
					Math.ceil((Date.parse(now()) - Date.parse(lease.createdAt)) / 60_000),
				),
				now(),
				unmet,
			);
		},
	};

	return {
		host,
		ready: async () => !!options.workerImage && !!options.workerAccountId,
		prewarm,
		discardWarm: async () => {
			await warming?.catch(() => undefined);
			const spare = warm;
			warm = undefined;
			if (spare) await options.docker.remove(spare.name, spare.containerId);
		},
	};
}
