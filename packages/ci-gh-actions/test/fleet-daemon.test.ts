/**
 * O42: the box worker runs as a fleet member. Its daemon composes
 * `createFleetAgent` against `createTestAuthority` with roles `DISPATCHER`
 * and `EXECUTOR`; the worker's memory, storage and host-health admission is
 * its `CapacitySource`; the `github-actions-job` source and runner (L16) are
 * its work kind; its sandboxes come from the drivers it is handed and its
 * egress from the proxy factory; the host Docker socket follows the fleet's
 * `allow_host_docker` on this `DEDICATED` device.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type EgressProxyFactory,
	FLEET_VIEW_CONTEXT,
	FleetViewSchema,
	Health,
	type MemberId,
	ObservationSchema,
	parseFleetId,
	ReceiptStatus,
	Role,
	type SandboxDriver,
	SandboxTier,
	SignedEnvelopeSchema,
	type UpstreamWork,
	WorkNeedsSchema,
	WorkOrigin,
	type WorkReceipt,
	WorkReceiptSchema,
	type WorkRunner,
	type WorkSource,
} from "@hobo/fleet";
import { createMemoryKeyStore } from "@hobo/fleet/keys";
import { createFakeSandboxDriver } from "@hobo/fleet/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BOX_ROLES,
	boxEnrollment,
	capacityFromAdmission,
	composeFleetDaemon,
	createJitRegistrationMinter,
	GITHUB_ACTIONS_JOB,
	type WorkerAdmissionSample,
} from "../src/fleet-daemon.js";
import type { GithubTransport } from "../src/github.js";
import {
	AUTHORITY_ORIGIN,
	boxWorld,
	FLEET,
	TENANT,
} from "./fleet-daemon-authority.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const now = () => Date.now();

beforeEach(() => {
	vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
	vi.useRealTimers();
});

const idle: WorkerAdmissionSample = {
	usedSlots: 0,
	hostHealth: "ok",
	draining: false,
	memoryAdmits: true,
	storageAdmits: true,
	freeMemoryMb: 12_000,
	freeDiskMb: 80_000,
};

/** The L16 source as a double of its frozen `WorkSource` shape: one queue, an empty registration. */
function githubJobs() {
	const queue: UpstreamWork[] = [];
	const source: WorkSource = {
		kind: GITHUB_ACTIONS_JOB,
		async poll() {
			return [...queue];
		},
		async prepare(offer) {
			const index = queue.findIndex((work) => work.workKey === offer.workKey);
			if (index >= 0) queue.splice(index, 1);
			return {
				ok: true,
				value: { parameters: {}, secret: new Uint8Array(), egressAllow: [] },
			};
		},
		async stillWanted() {
			return true;
		},
	};
	const add = (workKey: string) =>
		queue.push({
			workKey,
			label: "hobo",
			needs: create(WorkNeedsSchema, { labels: [] }),
			author: "github:1",
			origin: WorkOrigin.INTERNAL,
			repository: "",
			ref: "",
			workflowDigest: "",
			queuedAtMs: now(),
		});
	return { source, add };
}

/** The L16 runner as a double: records the work and the sandbox tier it was handed. */
function githubRunner() {
	const ran: { workKey: string; tier: SandboxTier }[] = [];
	const runner: WorkRunner = {
		kind: GITHUB_ACTIONS_JOB,
		async run(input) {
			ran.push({
				workKey: input.order.offer?.workKey ?? "",
				tier: input.sandbox.tier,
			});
			return {
				status: ReceiptStatus.SUCCEEDED,
				reason: "",
				outputDigest: "sha256:00",
				observedWorkKey: input.order.offer?.workKey ?? "",
			};
		},
	};
	return { runner, ran };
}

function egressRecorder() {
	let opened = 0;
	const egress: EgressProxyFactory = {
		async open() {
			opened += 1;
			return { url: "http://egress.box.invalid:3128", async close() {} };
		},
	};
	return { egress, opened: () => opened };
}

/** A fake driver that also records the egress proxy each sandbox was created behind. */
function recordingDriver(tier: SandboxTier) {
	const fake = createFakeSandboxDriver(tier);
	const egressUrls: string[] = [];
	const driver: SandboxDriver = {
		tier,
		available: () => fake.available(),
		async create(input) {
			egressUrls.push(input.egressProxyUrl);
			return fake.create(input);
		},
	};
	return { driver, egressUrls };
}

async function box(
	options: Readonly<{
		allowHostDocker?: boolean;
		admission?: () => WorkerAdmissionSample;
	}> = {},
) {
	const world = await boxWorld(now, {
		allowHostDocker: options.allowHostDocker ?? false,
	});
	const jobs = githubJobs();
	const run = githubRunner();
	const proxy = egressRecorder();
	const keys = createMemoryKeyStore();
	const s1 = recordingDriver(SandboxTier.S1_CONTAINER);
	const s3 = recordingDriver(SandboxTier.S3_MICROVM);
	const daemon = composeFleetDaemon({
		keys,
		authorityUrl: AUTHORITY_ORIGIN,
		tenant: TENANT,
		fleet: FLEET,
		connector: world.connector,
		admission: {
			slots: 4,
			labels: ["hobo"],
			read: async () => (options.admission ?? (() => idle))(),
		},
		work: { source: jobs.source, runner: run.runner },
		sandboxes: [s1.driver, s3.driver],
		egress: proxy.egress,
		agentVersion: "1.0.0",
		now,
		log: () => {},
		fetch: world.fetch,
	});
	const enrolled = await daemon.agent.enroll(
		boxEnrollment({
			tenant: TENANT,
			fleet: FLEET,
			name: "box-1",
			bootstrapToken: await world.token("box-1", BOX_ROLES),
			region: "eu-west",
			platform: { os: "linux", arch: "x64" },
		}),
	);
	if (!enrolled.ok) throw new Error(`enroll: ${enrolled.error.message}`);
	const memberId: MemberId = (await keys.open()).memberId;
	const egressUrls = () => [...s1.egressUrls, ...s3.egressUrls];
	return { world, jobs, run, proxy, keys, daemon, memberId, egressUrls };
}

function receiptsOn(world: Awaited<ReturnType<typeof boxWorld>>) {
	const seen: WorkReceipt[] = [];
	world.bus.events.subscribe(["receipt"], "start", async (event) => {
		seen.push(fromBinary(WorkReceiptSchema, event.payload));
	});
	return seen;
}

async function until(done: () => boolean, limitMs = 180_000): Promise<void> {
	for (let waited = 0; !done(); waited += 1_000) {
		if (waited >= limitMs) throw new Error("timed out waiting");
		await vi.advanceTimersByTimeAsync(1_000);
	}
}

describe("the box worker's fleet daemon", () => {
	it("enrolls against createTestAuthority as a DEDICATED member with roles DISPATCHER and EXECUTOR", async () => {
		const { world, memberId } = await box();
		const member = await world.bus.registry.member(memberId);
		expect(member?.memberships).toEqual([
			expect.objectContaining({
				fleet: FLEET,
				roles: [Role.DISPATCHER, Role.EXECUTOR],
			}),
		]);
		expect(BOX_ROLES).toEqual([Role.DISPATCHER, Role.EXECUTOR]);
	});

	it("dispatches a github-actions-job and runs it on itself, in a sandbox, behind the egress proxy", async () => {
		const { world, jobs, run, proxy, daemon, egressUrls } = await box();
		const receipts = receiptsOn(world);
		await daemon.agent.start();
		jobs.add("job-1");
		await until(() =>
			receipts.some((receipt) => receipt.status === ReceiptStatus.SUCCEEDED),
		);
		expect(run.ran).toHaveLength(1);
		expect(run.ran[0]?.workKey).toBe("job-1");
		expect(egressUrls()).toEqual(["http://egress.box.invalid:3128"]);
		expect(proxy.opened()).toBe(1);
		expect(daemon.agent.status().tiers).toEqual([
			SandboxTier.S1_CONTAINER,
			SandboxTier.S3_MICROVM,
		]);
		await daemon.agent.stop();
	});

	it("advertises the worker's admission as its capacity", async () => {
		let sample: WorkerAdmissionSample = { ...idle, usedSlots: 1 };
		const { world, daemon, memberId } = await box({ admission: () => sample });
		await daemon.agent.start();
		await vi.advanceTimersByTimeAsync(10_000);
		const latest = async () => {
			const own = (await world.bus.observations.read(100)).observations
				.filter((keyed) => keyed.memberId === memberId)
				.at(-1);
			return fromBinary(
				ObservationSchema,
				own?.envelope.payload ?? new Uint8Array(),
			);
		};
		expect((await latest()).capacity).toMatchObject({
			freeSlots: 3,
			totalSlots: 4,
			freeMemoryMb: 12_000,
			freeDiskMb: 80_000,
		});
		expect((await latest()).health).toBe(Health.REACHABLE);
		sample = { ...idle, hostHealth: "critical" };
		await vi.advanceTimersByTimeAsync(10_000);
		expect((await latest()).health).toBe(Health.PRESSURED);
		expect((await latest()).capacity?.freeSlots).toBe(0);
		await daemon.agent.stop();
	});

	it("reads its fleet's capacity from the registry's fleet view, and nothing before it is connected", async () => {
		const { world, daemon } = await box();
		await expect(daemon.fleetCapacity()).resolves.toBeUndefined();
		await daemon.agent.start();
		await until(() => daemon.agent.status().bus === "connected");
		await expect(daemon.fleetCapacity()).resolves.toBeUndefined();
		// The authority's projection signs a view; the memory registry decodes it without verifying.
		await world.bus.publisher.putView(
			create(SignedEnvelopeSchema, {
				context: FLEET_VIEW_CONTEXT,
				payload: toBinary(
					FleetViewSchema,
					create(FleetViewSchema, {
						fleet: FLEET,
						capacity: { live: 2, healthy: 2, totalSlots: 9, freeSlots: 5 },
						asOf: new Date(now()).toISOString(),
						notAfter: new Date(now() + 60_000).toISOString(),
					}),
				),
			}),
			parseFleetId(FLEET),
		);
		expect(await daemon.fleetCapacity()).toMatchObject({
			totalSlots: 9,
			freeSlots: 5,
		});
		await daemon.agent.stop();
	});

	it("mounts the host Docker socket only once the fleet allows it on this DEDICATED box", async () => {
		const refused = await box({ allowHostDocker: false });
		await refused.daemon.agent.start();
		await refused.daemon.refreshFleet();
		expect(refused.daemon.hostDocker()).toBe(false);
		await refused.daemon.agent.stop();

		const allowed = await box({ allowHostDocker: true });
		expect(allowed.daemon.hostDocker()).toBe(false);
		await allowed.daemon.agent.start();
		await allowed.daemon.refreshFleet();
		expect(allowed.daemon.hostDocker()).toBe(true);
		await allowed.daemon.agent.stop();
	});
});

describe("capacityFromAdmission", () => {
	const read = (sample: WorkerAdmissionSample) =>
		capacityFromAdmission({ slots: 4, labels: ["hobo"] }, sample);

	it("offers the slots the worker has left while every admission admits", () => {
		const { capacity, health, labels } = read({ ...idle, usedSlots: 3 });
		expect(capacity).toMatchObject({ freeSlots: 1, totalSlots: 4 });
		expect(health).toBe(Health.REACHABLE);
		expect(labels).toEqual(["hobo"]);
	});

	it("offers nothing when memory, storage or the host refuses, or the worker drains", () => {
		expect(read({ ...idle, memoryAdmits: false }).capacity.freeSlots).toBe(0);
		expect(read({ ...idle, storageAdmits: false }).capacity.freeSlots).toBe(0);
		expect(read({ ...idle, hostHealth: "critical" })).toMatchObject({
			health: Health.PRESSURED,
			capacity: { freeSlots: 0 },
		});
		expect(read({ ...idle, hostHealth: "pressured" }).health).toBe(
			Health.PRESSURED,
		);
		expect(read({ ...idle, draining: true })).toMatchObject({
			health: Health.DRAINING,
			capacity: { freeSlots: 0 },
		});
	});

	it("never reports more used slots than it has, and leaves unknown memory and disk unset", () => {
		const { capacity } = read({
			...idle,
			usedSlots: 9,
			freeMemoryMb: undefined,
			freeDiskMb: undefined,
		});
		expect(capacity.freeSlots).toBe(0);
		expect(capacity.freeMemoryMb).toBeUndefined();
		expect(capacity.freeDiskMb).toBeUndefined();
	});
});

describe("createJitRegistrationMinter", () => {
	const connections = async () => [
		{ installationId: 7, repository: "acme/app", runnerGroupId: 3 },
	];

	function github(status: number, body: string) {
		const calls: { installationId: number; path: string; body: string }[] = [];
		const transport: GithubTransport = {
			async request(installationId, path, _method, requestBody) {
				calls.push({ installationId, path, body: requestBody ?? "" });
				return new Response(body, { status });
			},
		};
		return { transport, calls };
	}

	it("asks GitHub for a single-use runner registration and returns it as the sealed secret", async () => {
		const { transport, calls } = github(
			201,
			JSON.stringify({ encoded_jit_config: "jit-secret", runner: { id: 31 } }),
		);
		const mint = createJitRegistrationMinter({
			github: transport,
			connections,
		});
		const outcome = await mint({
			repository: "acme/app",
			labels: ["hobo"],
			runnerName: "box-1-order-1",
		});
		expect(outcome.ok).toBe(true);
		if (outcome.ok)
			expect(new TextDecoder().decode(outcome.value)).toBe("jit-secret");
		expect(calls).toEqual([
			{
				installationId: 7,
				path: "/repos/acme/app/actions/runners/generate-jitconfig",
				body: JSON.stringify({
					name: "box-1-order-1",
					runner_group_id: 3,
					labels: ["hobo"],
					work_folder: "_hobo_work",
				}),
			},
		]);
	});

	it("refuses a repository the worker is not connected to, and a refused or malformed answer", async () => {
		const ok = github(201, JSON.stringify({ runner: { id: 31 } }));
		const mint = createJitRegistrationMinter({
			github: ok.transport,
			connections,
		});
		const unknown = await mint({
			repository: "acme/other",
			labels: ["hobo"],
			runnerName: "r",
		});
		expect(unknown.ok).toBe(false);
		expect(ok.calls).toEqual([]);
		const malformed = await mint({
			repository: "acme/app",
			labels: ["hobo"],
			runnerName: "r",
		});
		expect(malformed.ok).toBe(false);
		const refused = github(422, "{}");
		const refusing = createJitRegistrationMinter({
			github: refused.transport,
			connections,
		});
		const answer = await refusing({
			repository: "acme/app",
			labels: ["hobo"],
			runnerName: "r",
		});
		expect(answer.ok).toBe(false);
		if (!answer.ok) expect(answer.error.message).not.toMatch(/jit/iu);
	});
});
