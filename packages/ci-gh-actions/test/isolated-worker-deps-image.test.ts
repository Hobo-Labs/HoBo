import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create, type JsonObject } from "@bufbuild/protobuf";
import {
	BudgetLedgerSnapshotSchema,
	createSqliteBudgetAdmissionAuthority,
	HostingQuoteSchema,
} from "@hobo/broker";
import {
	AccountSchema,
	type CiSharedBudgetHooks,
	ConfigurationSchema,
	ConnectionSchema,
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	createCiSharedBudgetHooks,
	JobSchema,
	type Lease,
	OfferSchema,
} from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { createIsolatedContainerController } from "../src/isolated-worker/container-controller.js";
import type {
	DockerDriver,
	DockerImageInspection,
	IsolatedContainerSpec,
} from "../src/isolated-worker/docker-driver.js";
import { commonBudget } from "./fixtures/common-budget.js";

const NOW = "2026-11-02T12:00:00Z";
const TOOLCHAIN = "v0123456789ab";
const DEPS_KEY = `${TOOLCHAIN}-0123456789abcdef`;

function fakeDocker() {
	const specs: IsolatedContainerSpec[] = [];
	const inspectCalls: string[] = [];
	const images = new Map<string, DockerImageInspection | Error>([
		[
			"hobo-ci-worker:local",
			{
				id: "worker-id",
				repoTags: ["hobo-ci-worker:local", `hobo-ci-worker:${TOOLCHAIN}`],
				labels: {},
			},
		],
		[
			"hobo-ci-deps:local",
			{
				id: "deps-id",
				repoTags: ["hobo-ci-deps:local"],
				labels: {
					"hobo.ci.deps-key": DEPS_KEY,
					"hobo.ci.toolchain": TOOLCHAIN,
				},
			},
		],
	]);
	let next = 0;
	let probeExitCode = 0;
	const probeCalls: string[] = [];
	const resourceUpdates: { containerId: string; cpuShares: number }[] = [];
	const driver: DockerDriver = {
		inspectImage: vi.fn(async (image: string) => {
			inspectCalls.push(image);
			const inspection = images.get(image);
			if (inspection instanceof Error) throw inspection;
			if (!inspection) throw new Error(`missing image ${image}`);
			return inspection;
		}),
		probeImage: vi.fn(async (image: string) => {
			probeCalls.push(image);
			return { exitCode: probeExitCode };
		}),
		create: vi.fn(async (spec) => {
			specs.push(spec);
			next += 1;
			return { name: spec.name, containerId: String(next).padStart(64, "0") };
		}),
		start: vi.fn(async () => undefined),
		exec: vi.fn(async () => ({ exitCode: 0 })),
		execDetached: vi.fn(async () => ({ exitCode: 0 })),
		writeSecret: vi.fn(async () => undefined),
		rename: vi.fn(async () => undefined),
		updateResources: vi.fn(async (containerId, weights) => {
			resourceUpdates.push({ containerId, cpuShares: weights.cpuShares });
		}),
		stop: vi.fn(async () => undefined),
		remove: vi.fn(async () => undefined),
		isRunning: vi.fn(async () => true),
	};
	return {
		driver,
		specs,
		resourceUpdates,
		inspectCalls,
		probeCalls,
		images,
		setProbeExitCode: (exitCode: number) => {
			probeExitCode = exitCode;
		},
	};
}

const github: GithubTransport = {
	request: async () =>
		Response.json(
			{ encoded_jit_config: "c2VjcmV0", runner: { id: 42 } },
			{ status: 201 },
		),
};

describe("isolated worker deps image selection", () => {
	let root = "";
	let store: SqliteCiStore | undefined;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hobo-ci-deps-image-"));
	});
	afterEach(() => {
		store?.close();
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function reservedLease(
		repository: string,
		queueDeadlineAt = "",
		shared?: { hooks: CiSharedBudgetHooks; policy: JsonObject },
	) {
		const path = join(root, `${randomUUID()}.sqlite`);
		store = new SqliteCiStore(
			path,
			shared ? { sharedBudget: shared.hooks } : {},
		);
		await store.configure(
			create(ConfigurationSchema, {
				accounts: [
					create(AccountSchema, {
						id: "hobo-labs",
						budgetPolicy: shared?.policy,
						maxRuntimeMinutes: 30,
						startupMinutes: 5,
						offers: [
							create(OfferSchema, {
								id: "box-isolated",
								provider: "kubernetes",
								providerAccountId: "box",
								enabled: true,
								runsOn: "hobo-isolated-worker",
								backend: "isolated-container",
								concurrency: 1,
								observedAt: "2026-11-02T00:00:00Z",
								validUntil: "2026-12-31T23:59:59Z",
								sourceUrl: "https://example.test/box-evidence",
								bridgeAcknowledged: true,
							}),
						],
					}),
				],
				connections: [
					create(ConnectionSchema, {
						accountId: "hobo-labs",
						installationId: 10,
						repositoryId: 101,
						repository,
						runnerGroupId: 1,
						isolatedOnly: true,
						acceptAllMatchingRepositoryJobs: true,
						trustedRepositoryAcknowledged: true,
						publicRepositoryAcknowledged: true,
					}),
				],
			}),
			0,
			NOW,
		);
		const configured = await store.configuration();
		const account = configured?.configuration.accounts[0];
		if (!configured || !account) throw new Error("missing fixture account");
		const job = create(JobSchema, {
			id: 1,
			runId: 11,
			runAttempt: 1,
			repositoryId: 101,
			installationId: 10,
			repository,
			labels: ["hobo"],
			action: "queued",
			isolatedRequired: true,
			queueDeadlineAt,
		});
		await store.queue(job, NOW, configured.revision);
		const lease = await store.reserve(account, job, NOW, configured.revision);
		if (!lease) throw new Error("fixture lease was not reserved");
		return lease;
	}

	function controller(
		driver: DockerDriver,
		workRoot?: string,
		clock = () => NOW,
		extra?: Pick<
			Parameters<typeof createIsolatedContainerController>[0],
			"gitMirror" | "headShaFor"
		>,
	) {
		if (!store) throw new Error("fixture store not initialized");
		const workFs = {
			statfs: vi.fn(async () => ({
				blocks: 100,
				bfree: 100,
				files: 100,
				ffree: 100,
			})),
			device: vi.fn(async () => 1),
			jobDirectories: vi.fn(async () => []),
			retiredDirectories: vi.fn(async () => []),
			prepareJobDirectory: vi.fn(async () => undefined),
			retireJobDirectory: vi.fn(async () => undefined),
			removeJobDirectory: vi.fn(async () => ({ bytes: 0, entries: 0 })),
		};
		const controllerOptions = {
			store,
			github,
			publicOrigin: "https://relay.example",
			docker: driver,
			workerAccountId: "box",
			workerImage: "hobo-ci-worker:local",
			slots: 1,
			now: clock,
			...extra,
		};
		if (workRoot !== undefined)
			Object.assign(controllerOptions, {
				workRoot,
				workFs,
				scheduleRetiredSweep: vi.fn(),
			});
		return createIsolatedContainerController(controllerOptions);
	}

	it("uses the deps image and exports its key after a successful probe", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		const docker = fakeDocker();
		await controller(docker.driver).host.launch(lease.id);
		expect(docker.specs).toHaveLength(1);
		expect(docker.specs[0]?.image).toBe("hobo-ci-deps:local");
		expect(docker.specs[0]?.env.HOBO_CI_DEPS_LAYER).toBe(DEPS_KEY);
		expect(docker.probeCalls).toEqual(["hobo-ci-deps:local"]);
	});

	it("does not create a job container after image preflight exhausts the queue deadline", async () => {
		const deadline = "2026-11-02T12:01:00Z";
		const lease = await reservedLease("hobo-labs/hobo", deadline);
		expect(Date.parse(lease.queueDeadlineAt)).toBe(Date.parse(deadline));
		const docker = fakeDocker();
		let clock = NOW;
		vi.mocked(docker.driver.probeImage).mockImplementation(async () => {
			clock = deadline;
			return { exitCode: 0 };
		});
		await controller(docker.driver, undefined, () => clock).host.launch(
			lease.id,
		);
		expect(docker.driver.create).not.toHaveBeenCalled();
		expect(docker.driver.start).not.toHaveBeenCalled();
		expect((await store?.get(lease.id))?.state).toBe("uncertain");
	});

	it("stops a newly created container without starting it if creation exhausts the deadline", async () => {
		const deadline = "2026-11-02T12:01:00Z";
		const lease = await reservedLease("hobo-labs/hobo", deadline);
		const docker = fakeDocker();
		let clock = NOW;
		vi.mocked(docker.driver.create).mockImplementation(async (spec) => {
			clock = deadline;
			return { name: spec.name, containerId: "a".repeat(64) };
		});
		await controller(docker.driver, undefined, () => clock).host.launch(
			lease.id,
		);
		expect(docker.driver.start).not.toHaveBeenCalled();
		expect(docker.driver.stop).toHaveBeenCalledOnce();
		expect(docker.driver.remove).toHaveBeenCalledOnce();
		expect((await store?.get(lease.id))?.state).toBe("uncertain");
	});

	it.each([
		"registration",
		"secret",
	] as const)("does not start a runner when %s exhausts the queue deadline", async (stage) => {
		const deadline = "2026-11-02T12:01:00Z";
		const lease = await reservedLease("hobo-labs/hobo", deadline);
		const docker = fakeDocker();
		let clock = NOW;
		vi.spyOn(github, "request").mockImplementation(async () => {
			if (stage === "registration") clock = deadline;
			return Response.json(
				{ encoded_jit_config: "c2VjcmV0", runner: { id: 42 } },
				{ status: 201 },
			);
		});
		vi.mocked(docker.driver.writeSecret).mockImplementation(async () => {
			if (stage === "secret") clock = deadline;
		});
		await controller(docker.driver, undefined, () => clock).host.launch(
			lease.id,
		);
		expect(docker.driver.execDetached).not.toHaveBeenCalled();
		expect(docker.driver.stop).toHaveBeenCalledOnce();
		const observed = await store?.get(lease.id);
		expect(observed?.state).toBe("uncertain");
		expect(observed?.runnerId).toBe(42);
	});

	it("uses planning semantics and retains other payer measurements in isolated preflight", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		if (!store) throw new Error("missing fixture store");
		const snapshot = await store.policySnapshot();
		const account = snapshot.state?.configuration.accounts[0];
		const isolated = account?.offers[0];
		if (!account || !isolated) throw new Error("missing fixture account");
		account.budgetPolicy = {
			...commonBudget(),
			enforcement: "strict",
			constraints: [
				{ key: "ci.attempts", workload: "ci", unit: "count", maximum: 1 },
				{
					key: "ci.queue.duration",
					workload: "ci",
					unit: "ms",
					maximum: 60000,
				},
				{
					key: "provider.cost",
					workload: "ci",
					unit: "USD.micros",
					target: "other-account",
					maximum: 0,
				},
			],
		};
		const other = clone(OfferSchema, isolated);
		other.id = "other";
		other.providerAccountId = "other-account";
		other.backend = "gh-actions";
		account.offers.push(other);
		vi.spyOn(store, "policySnapshot").mockResolvedValue(snapshot);
		const docker = fakeDocker();
		await controller(docker.driver).host.launch(lease.id);
		expect(docker.driver.create).toHaveBeenCalledOnce();
	});

	it.each([
		"valid",
		"revoked",
		"mirror-expired",
	] as const)("enforces live strict parent claim before an isolated effect (%s)", async (scenario) => {
		const policy = {
			...commonBudget(),
			enforcement: "strict",
			constraints: [
				{ key: "ci.attempts", workload: "ci", unit: "count", maximum: 1 },
				{
					key: "ci.queue.duration",
					workload: "ci",
					unit: "ms",
					maximum: 60000,
				},
			],
		};
		const parent = createSqliteBudgetAdmissionAuthority({
			path: join(root, `${randomUUID()}-parent.sqlite`),
			now: () => NOW,
			snapshot: create(BudgetLedgerSnapshotSchema, {
				identity: {
					tenantId: policy.tenantId,
					budgetId: policy.budgetId,
					periodId: policy.periodId,
					policyRevision: policy.revision,
				},
				limitMicros: policy.limitMicros,
				observedAt: NOW,
				validUntil: "2026-12-31T23:59:59Z",
				providerAccounts: [
					{ providerAccountId: "box", limitMicros: policy.limitMicros },
				],
			}),
		});
		let proof = true;
		const hooks = createCiSharedBudgetHooks({
			authority: parent,
			now: () => NOW,
			verifyProviderLiabilityBound: () => proof,
			quoteLease: (lease: Lease) =>
				create(HostingQuoteSchema, {
					quoteId: `quote:${ciReservationId(lease)}`,
					yardId: `ci:${lease.accountId}`,
					providerId: lease.provider,
					ownerTenantId: lease.budgetTenantId,
					currency: "USD",
					totalMicros: lease.reservedPaidMicros,
					liabilityBoundMicros: lease.reservedPaidMicros,
					observedAt: NOW,
					validUntil: "2026-12-31T23:59:59Z",
					components: [
						{
							name: "complete-native-liability",
							costMicros: lease.reservedPaidMicros,
						},
					],
					requestDigest: ciRequestDigest(lease),
					financialPlanHash: ciFinancialPlanHash(lease),
					providerAccounts: [
						{
							providerAccountId: lease.providerAccountId,
							liabilityMicros: lease.reservedPaidMicros,
						},
					],
				}),
		});
		try {
			const lease = await reservedLease("hobo-labs/hobo", "", {
				hooks,
				policy,
			});
			proof = scenario !== "revoked";
			const docker = fakeDocker();
			let clock = NOW;
			const request = vi.spyOn(github, "request");
			const extra =
				scenario === "mirror-expired"
					? {
							headShaFor: async () => "1".repeat(40),
							gitMirror: {
								pathFor: () => undefined,
								ensure: async () => {
									clock = lease.queueDeadlineAt;
									return {
										status: "miss" as const,
										reason: "expired while fetching",
									};
								},
							},
						}
					: undefined;
			await controller(
				docker.driver,
				undefined,
				() => clock,
				extra,
			).host.launch(lease.id);
			const held = parent.lookup(ciReservationId(lease));
			expect(held?.status).toBe(
				scenario === "mirror-expired" ? "uncertain" : "held",
			);
			if (scenario === "valid") {
				expect(docker.driver.create).toHaveBeenCalledOnce();
				expect(held?.executionDigest).not.toBe("");
			} else {
				expect(docker.driver.create).not.toHaveBeenCalled();
				expect(request).not.toHaveBeenCalled();
				if (scenario === "revoked") expect(held?.executionDigest).toBe("");
				else expect(held?.executionDigest).not.toBe("");
			}
		} finally {
			parent.close();
		}
	});

	it.each([
		"different-repository",
		"mirror-appears",
	] as const)("does not reuse a warm container with a stale git mirror (%s)", async (scenario) => {
		const repository = "owner/b";
		const lease = await reservedLease(repository);
		const docker = fakeDocker();
		const pathFor = (name: string) => join(root, name.replace("/", "-"));
		const warmRepository =
			scenario === "different-repository" ? "owner/a" : repository;
		if (scenario === "different-repository") {
			mkdirSync(pathFor(warmRepository));
			mkdirSync(pathFor(repository));
		}
		const ctl = controller(docker.driver, undefined, () => NOW, {
			gitMirror: { pathFor },
		});
		await ctl.prewarm(warmRepository);
		if (scenario === "mirror-appears") mkdirSync(pathFor(repository));
		await ctl.host.launch(lease.id);
		expect(docker.driver.rename).not.toHaveBeenCalled();
		expect(docker.specs).toHaveLength(2);
		expect(docker.specs[1]?.env.HOBO_CI_GIT_MIRROR).toBe(pathFor(repository));
		expect(docker.specs[1]?.volumes).toContainEqual({
			source: pathFor(repository),
			target: pathFor(repository),
			readonly: true,
		});
	});

	it("retains an uncertain lease when container creation loses its reply", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		const docker = fakeDocker();
		vi.mocked(docker.driver.create).mockRejectedValue(
			new Error("lost create reply"),
		);
		let clock = NOW;
		const ctl = controller(docker.driver, undefined, () => clock);
		await ctl.host.launch(lease.id);
		expect((await store?.get(lease.id))?.state).toBe("uncertain");
		clock = "2026-11-02T12:10:00Z";
		await ctl.host.reconcile(lease.id, true);
		expect((await store?.get(lease.id))?.state).toBe("uncertain");
		expect(docker.driver.start).not.toHaveBeenCalled();
	});

	it("retires a completed isolated runner after its admission deadline", async () => {
		const deadline = "2026-11-02T12:01:00Z";
		const lease = await reservedLease("hobo-labs/hobo", deadline);
		const docker = fakeDocker();
		let clock = NOW;
		const ctl = controller(docker.driver, undefined, () => clock);
		await ctl.host.launch(lease.id);
		expect((await store?.get(lease.id))?.state).toBe("running");
		clock = deadline;
		vi.spyOn(github, "request").mockResolvedValue(
			Response.json({
				id: 1,
				run_id: 11,
				status: "completed",
				labels: ["hobo"],
			}),
		);
		await ctl.host.reconcile(lease.id, true);
		expect(docker.driver.stop).toHaveBeenCalledOnce();
		expect(docker.driver.remove).toHaveBeenCalledOnce();
		expect(await store?.get(lease.id)).toMatchObject({
			state: "completed",
			sandboxStage: "stopped",
			usageCompletedAt: deadline,
		});
	});

	it("fences and retires an interrupted create through the durable SQLite store", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		if (!store) throw new Error("missing store");
		await store.transition(
			lease.id,
			["reserved"],
			(entry) => {
				entry.state = "dispatching";
				entry.sandboxName = `hobo-${entry.id}`;
				entry.sandboxStage = "creating";
			},
			"ci.DispatchRequested",
			NOW,
		);
		const docker = fakeDocker();
		docker.driver.list = vi.fn(async () => [
			{
				name: `hobo-${lease.id}`,
				containerId: "observed-session",
				state: "running" as const,
			},
		]);
		const later = "2026-11-02T12:06:00Z";
		vi.spyOn(github, "request").mockResolvedValue(
			Response.json({
				id: 1,
				run_id: 11,
				status: "completed",
				labels: ["hobo"],
			}),
		);
		const ctl = controller(docker.driver, undefined, () => later);
		await ctl.reconcileLeases();
		expect(docker.driver.stop).toHaveBeenCalledWith(
			`hobo-${lease.id}`,
			"observed-session",
		);
		expect(docker.driver.remove).toHaveBeenCalledOnce();
		expect(docker.driver.start).not.toHaveBeenCalled();
		expect(await store.get(lease.id)).toMatchObject({
			state: "completed",
			sandboxStage: "stopped",
			usageCompletedAt: later,
		});
		// A delayed create reply cannot advance the retired reservation.
		expect(
			await store.transition(
				lease.id,
				["dispatching"],
				(entry) => {
					entry.state = "dispatched";
					entry.sandboxSessionId = "observed-session";
				},
				"ci.SandboxCreated",
				later,
			),
		).toBeUndefined();
	});

	it("retains an uncertain lease for a mismatched container creation identity", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		const docker = fakeDocker();
		vi.mocked(docker.driver.create).mockResolvedValue({
			name: "other-container",
			containerId: "a".repeat(64),
		});
		await controller(docker.driver).host.launch(lease.id);
		expect((await store?.get(lease.id))?.state).toBe("uncertain");
		expect(docker.driver.start).not.toHaveBeenCalled();
		expect(docker.driver.remove).not.toHaveBeenCalled();
	});

	it("retains an uncertain lease when runner registration loses its reply", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		const docker = fakeDocker();
		vi.spyOn(github, "request").mockRejectedValue(
			new Error("lost registration reply"),
		);
		await controller(docker.driver).host.launch(lease.id);
		expect((await store?.get(lease.id))?.state).toBe("uncertain");
		expect(docker.driver.writeSecret).not.toHaveBeenCalled();
		expect(docker.driver.stop).toHaveBeenCalledOnce();
	});

	it("retains an uncertain lease when cleanup after a failed start is unconfirmed", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		const docker = fakeDocker();
		vi.mocked(docker.driver.start).mockRejectedValue(
			new Error("lost start reply"),
		);
		vi.mocked(docker.driver.stop).mockRejectedValue(
			new Error("stop unavailable"),
		);
		await controller(docker.driver).host.launch(lease.id);
		expect((await store?.get(lease.id))?.state).toBe("uncertain");
		expect(docker.driver.writeSecret).not.toHaveBeenCalled();
	});

	it("requeues a failed start only after the container is definitely removed", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		const docker = fakeDocker();
		vi.mocked(docker.driver.start).mockRejectedValue(new Error("start failed"));
		await controller(docker.driver).host.launch(lease.id);
		expect(docker.driver.stop).toHaveBeenCalledOnce();
		expect(docker.driver.remove).toHaveBeenCalledOnce();
		expect((await store?.get(lease.id))?.state).toBe("cancelled");
		expect(await store?.pendingJobs()).toHaveLength(1);
	});

	it("probes once per deps image id", async () => {
		await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		const ctl = controller(docker.driver);
		await ctl.prewarm("Hobo-Labs/HoBo");
		await ctl.discardWarm();
		await ctl.prewarm("Hobo-Labs/HoBo");
		await ctl.discardWarm();
		expect(docker.probeCalls).toEqual(["hobo-ci-deps:local"]);
		const deps = docker.images.get("hobo-ci-deps:local");
		if (!deps || deps instanceof Error) throw new Error("missing fixture");
		docker.images.set("hobo-ci-deps:local", { ...deps, id: "next-deps-id" });
		await ctl.prewarm("Hobo-Labs/HoBo");
		await ctl.discardWarm();
		expect(docker.probeCalls).toEqual([
			"hobo-ci-deps:local",
			"hobo-ci-deps:local",
		]);
	});

	it("selects the off-workdir deps layer for a mounted job after a successful probe", async () => {
		const lease = await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		await controller(docker.driver, root).host.launch(lease.id);
		expect(docker.specs[0]?.image).toBe("hobo-ci-deps:local");
		expect(docker.specs[0]?.env.HOBO_CI_DEPS_LAYER).toBe(DEPS_KEY);
		expect(docker.specs[0]?.env.HOBO_CI_HOST_JOB_DIRECTORY).toBe(
			join(root, `hobo-${lease.id}`),
		);
		expect(docker.probeCalls).toEqual(["hobo-ci-deps:local"]);
	});

	it.each([
		[3, "unwritable-workdir"],
		[4, "missing-payload"],
		[1, "probe-failed"],
	])("falls back and logs probe exit %i as %s", async (exitCode, reason) => {
		const lease = await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		docker.setProbeExitCode(exitCode);
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			await controller(docker.driver).host.launch(lease.id);
			expect(docker.specs[0]?.image).toBe("hobo-ci-worker:local");
			expect(docker.specs[0]?.env.HOBO_CI_DEPS_LAYER).toBeUndefined();
			expect(error).toHaveBeenCalledWith(
				JSON.stringify({
					event: "hobo_ci_deps_image_fallback",
					image: "hobo-ci-deps:local",
					reason,
				}),
			);
		} finally {
			error.mockRestore();
		}
	});

	it("gives trunk containers high CPU and IO weights and PR containers low weights", async () => {
		const trunkLease = await reservedLease("Hobo-Labs/HoBo");
		const trunkDocker = fakeDocker();
		await controller(trunkDocker.driver).host.launch(trunkLease.id, "hobo", 0);
		expect(trunkDocker.specs[0]).toMatchObject({
			cpuShares: 8_192,
			blkioWeight: 800,
		});

		const prLease = await reservedLease("Hobo-Labs/HoBo");
		const prDocker = fakeDocker();
		await controller(prDocker.driver).host.launch(prLease.id, "hobo", 1);
		expect(prDocker.specs[0]).toMatchObject({
			cpuShares: 512,
			blkioWeight: 200,
		});
	});

	it("starts a warm spare at PR weight and updates it for trunk assignment", async () => {
		const lease = await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		const ctl = controller(docker.driver);
		await ctl.prewarm("Hobo-Labs/HoBo");
		expect(docker.specs[0]).toMatchObject({
			cpuShares: 512,
			blkioWeight: 200,
		});
		await ctl.host.launch(lease.id, "hobo-trunk", 0);
		expect(docker.specs).toHaveLength(1);
		expect(docker.resourceUpdates).toEqual([
			{ containerId: `${"0".repeat(63)}1`, cpuShares: 8_192 },
		]);
	});

	it("claims the layer on a job mount because the payload is outside it and probed", async () => {
		const lease = await reservedLease("hobo-labs/hobo");
		const docker = fakeDocker();
		const workRoot = join(root, "work");
		await controller(docker.driver, workRoot).host.launch(lease.id);
		expect(docker.specs).toHaveLength(1);
		expect(docker.specs[0]?.image).toBe("hobo-ci-deps:local");
		expect(docker.specs[0]?.volumes).toContainEqual({
			source: join(workRoot, `hobo-${lease.id}`),
			target: "/opt/actions-runner/_hobo_work",
		});
		expect(docker.specs[0]?.env.HOBO_CI_DEPS_LAYER).toBe(DEPS_KEY);
		expect(docker.probeCalls).toEqual(["hobo-ci-deps:local"]);
	});

	it("falls back when the deps toolchain does not match", async () => {
		const lease = await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		const deps = docker.images.get("hobo-ci-deps:local");
		if (!deps || deps instanceof Error) throw new Error("missing fixture");
		docker.images.set("hobo-ci-deps:local", {
			...deps,
			labels: { ...deps.labels, "hobo.ci.toolchain": "v111111111111" },
		});
		await controller(docker.driver).host.launch(lease.id);
		expect(docker.specs[0]?.image).toBe("hobo-ci-worker:local");
		expect(docker.specs[0]?.env.HOBO_CI_DEPS_LAYER).toBeUndefined();
	});

	it("never selects the HoBo deps image for another repository", async () => {
		const lease = await reservedLease("Hobo-Labs/ts-autocode");
		const docker = fakeDocker();
		await controller(docker.driver).host.launch(lease.id);
		expect(docker.specs[0]?.image).toBe("hobo-ci-worker:local");
		expect(docker.inspectCalls).toEqual([]);
	});

	it("falls back when the deps image is missing", async () => {
		const lease = await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		docker.images.set("hobo-ci-deps:local", new Error("missing"));
		await controller(docker.driver).host.launch(lease.id);
		expect(docker.specs[0]?.image).toBe("hobo-ci-worker:local");
	});

	it("creates a fresh container instead of taking a mismatched prewarm", async () => {
		const lease = await reservedLease("Hobo-Labs/HoBo");
		const docker = fakeDocker();
		const ctl = controller(docker.driver);
		await ctl.prewarm("Hobo-Labs/ts-autocode");
		await ctl.host.launch(lease.id);
		expect(docker.specs.map((spec) => spec.image)).toEqual([
			"hobo-ci-worker:local",
			"hobo-ci-deps:local",
		]);
		expect(docker.driver.rename).not.toHaveBeenCalled();
	});
});
