import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { type Lease, LeaseSchema } from "@hobo/ci";
import {
	type HttpTransport,
	type ResolveRequest,
	ResolverError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createCliDockerDriver } from "../src/isolated-worker/cli-docker-driver.js";
import type {
	DockerContainer,
	IsolatedContainerSpec,
} from "../src/isolated-worker/docker-driver.js";
import { parseMeshAdvert } from "../src/mesh-records.js";
import {
	controllerContainerName,
	createRunnerHostResolver,
	inFlightJobCount,
	RUNNER_HOST_PRODUCT_ID,
	RUNNER_HOST_REALIZER_BINDING,
	RUNNER_HOST_RETAINED_FIELDS,
	RUNNER_HOST_TRAFFIC_ROUTING_ABSENT,
	RUNNER_HOST_TRAFFIC_ROUTING_PROFILE,
	type RunnerHostAdvert,
	type RunnerHostPorts,
	type RunnerHostRealizerOptions,
	runnerHostCampReport,
	runnerHostIdForCamp,
	runnerHostInterfaceGaps,
	runnerHostProductRefusal,
	runnerHostResolveRequest,
	runnerHostResolverRegistry,
} from "../src/runner-host-realizer.js";

const recorded = JSON.parse(
	readFileSync(
		new URL("./fixtures/runner-host/box-host.json", import.meta.url),
		"utf8",
	),
);
const PREVIOUS: string = recorded.previousImage;
const TARGET: string = recorded.targetImage;
const digestOf = (image: string) => image.slice(image.indexOf("@") + 1);
const recordedAdvert = parseMeshAdvert(recorded.meshAdvert);
if (!recordedAdvert) throw new Error("fixture mesh advert does not parse");
const CREDENTIAL_REF = "env://HOBO_CI_GHCR_READ_TOKEN";
const transport: HttpTransport = async () => {
	throw new Error("the runner-host realizer makes no HTTP call");
};

const lease = (id: string, state: string, runnerName = `hobo-${id}`): Lease =>
	create(LeaseSchema, { id, state, runnerName, jobId: 1, repositoryId: 1 });

type FakeOptions = Readonly<{
	running?: string;
	/** Digests whose controller never advertises healthy. */
	unhealthy?: readonly string[];
	/** Images whose pull fails. */
	unpullable?: readonly string[];
	leases?: Lease[];
	/** Called on every sleep with the fake clock: lets jobs finish. */
	onTick?: (host: FakeHost) => void;
	startMs?: number;
}>;

/**
 * A runner host as the realizer sees it: the Docker driver's container
 * semantics (`--rm`, so a stopped controller is gone), the worker's leases,
 * GitHub runner presence, and the host's mesh advert, derived from the
 * recorded advert and whichever controller is running.
 */
class FakeHost {
	nowMs: number;
	readonly calls: string[] = [];
	readonly images = new Set<string>();
	readonly containers = new Map<
		string,
		Omit<DockerContainer, "state"> & {
			state: DockerContainer["state"];
			image: string;
			startedAtMs?: number;
		}
	>();
	leases: Lease[];
	admission = true;
	nextId = 1;

	constructor(readonly options: FakeOptions = {}) {
		this.nowMs = options.startMs ?? recordedAdvert?.sinceMs ?? 0;
		this.leases = options.leases ?? [];
		if (options.running) {
			this.images.add(options.running);
			const name = controllerContainerName(digestOf(options.running));
			this.containers.set(recorded.controllerContainer.containerId, {
				...recorded.controllerContainer,
				name,
				image: options.running,
				startedAtMs: this.nowMs - 60_000,
			});
		}
	}

	runningController() {
		return [...this.containers.values()].find(
			(container) =>
				container.state === "running" &&
				container.name.startsWith("hoboci-runner-controller-"),
		);
	}

	ports(): RunnerHostPorts {
		return portsOf(this);
	}

	inFlight() {
		return inFlightJobCount(this.leases, []);
	}

	resolverOptions(
		extra: Partial<RunnerHostRealizerOptions> = {},
	): RunnerHostRealizerOptions {
		return {
			hostId: "box",
			hostKind: "box-worker",
			host: this.ports(),
			now: () => this.nowMs,
			sleep: async (ms) => {
				this.nowMs += ms;
				this.options.onTick?.(this);
			},
			pollIntervalMs: 60_000,
			verifyDeadlineMs: 5 * 60_000,
			drainDeadlineMs: 30 * 60_000,
			...extra,
		};
	}
}

/** The ports a FakeHost hands the realizer. */
function portsOf(host: FakeHost): RunnerHostPorts {
	return {
		containers: {
			async listWorkerContainers() {
				host.calls.push("list");
				return [...host.containers.values()].map(
					({ image: _image, startedAtMs: _started, ...container }) => container,
				);
			},
			async pull(image: string) {
				host.calls.push(`pull ${image}`);
				if (host.options.unpullable?.includes(image))
					throw new Error("manifest unknown");
				host.images.add(image);
			},
			async inspectImage(image: string) {
				if (!host.images.has(image)) throw new Error("No such image");
				return { id: digestOf(image), repoTags: [], labels: {} };
			},
			async create(spec: IsolatedContainerSpec) {
				host.calls.push(`create ${spec.name}`);
				if (!host.images.has(spec.image)) throw new Error("No such image");
				for (const container of host.containers.values())
					if (container.name === spec.name)
						throw new Error("Conflict. The container name is already in use");
				const containerId = String(host.nextId++).padStart(64, "c");
				host.containers.set(containerId, {
					name: spec.name,
					containerId,
					state: "created",
					image: spec.image,
				});
				return { name: spec.name, containerId };
			},
			async start(_name: string, containerId: string) {
				host.calls.push(`start ${containerId.slice(-4)}`);
				const container = host.containers.get(containerId);
				if (!container) throw new Error("No such container");
				container.state = "running";
				container.startedAtMs = host.nowMs;
			},
			async stop(_name: string, containerId: string) {
				host.calls.push(`stop ${containerId.slice(-4)}`);
				if (
					host.inFlight() > 0 &&
					host.runningController()?.containerId === containerId
				)
					host.calls.push("STOPPED-WITH-JOBS-IN-FLIGHT");
				host.containers.delete(containerId);
			},
			async remove(_name: string, containerId: string) {
				if (!host.containers.delete(containerId))
					throw new Error("No such container");
			},
			async isRunning(_name: string, containerId: string) {
				return host.containers.get(containerId)?.state === "running";
			},
		},
		jobs: {
			async leases() {
				return host.leases;
			},
			async runners() {
				const github = recorded.githubRunner;
				return host.leases
					.filter((entry) => entry.state === "running")
					.map((entry) => ({
						name: entry.runnerName,
						presence: { status: github.status, busy: github.busy },
					}));
			},
			async meshAdvert(): Promise<RunnerHostAdvert | undefined> {
				const live = host.runningController();
				if (!live || !recordedAdvert) return undefined;
				return {
					...recordedAdvert,
					healthy:
						host.admission && !host.options.unhealthy?.includes(live.image),
					validUntilMs: host.nowMs + 60_000,
					sinceMs: live.startedAtMs ?? 0,
				};
			},
			async pauseAdmission() {
				host.calls.push("pause");
				host.admission = false;
			},
			async resumeAdmission() {
				host.calls.push("resume");
				host.admission = true;
			},
		},
	};
}

const request = (
	image: string,
	extra: Partial<Parameters<typeof runnerHostResolveRequest>[0]> = {},
) =>
	runnerHostResolveRequest({
		campId: "hobo-ci-runners/box",
		image,
		credentialRef: CREDENTIAL_REF,
		...extra,
	});

async function refusal(promise: Promise<unknown>): Promise<ResolverError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ResolverError) return error;
		throw error;
	}
	throw new Error("expected a ResolverError");
}

describe("runner-host realizer: converge", () => {
	it("starts the controller on a host with none and reports it only once observed", async () => {
		const host = new FakeHost();
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const outcome = await resolver.reconcile(request(TARGET), transport);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe("hobo-ci-runners/box/controller");
		expect(outcome.outputs.controllerDigest).toBe(digestOf(TARGET));
		expect(outcome.outputs.image).toBe(TARGET);
		expect(outcome.outputs.claims).toEqual({
			platform: "linux/x64",
			capacity: "4",
		});
		expect(outcome.outputs.retained).toEqual([...RUNNER_HOST_RETAINED_FIELDS]);
		expect(host.calls).toContain(`pull ${TARGET}`);
		expect(host.admission).toBe(true);
	});

	it("is idempotent by digest: a host already serving the target is a noop with no pull", async () => {
		const host = new FakeHost({ running: TARGET });
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const first = await resolver.reconcile(request(TARGET), transport);
		const second = await resolver.reconcile(request(TARGET), transport);
		expect(first.action).toBe("noop");
		expect(second).toEqual(first);
		expect(host.calls.some((call) => call.startsWith("pull"))).toBe(false);
		expect(host.calls).not.toContain("pause");
	});

	it("drains in-flight jobs before the swap and never stops a controller holding one", async () => {
		const host = new FakeHost({
			running: PREVIOUS,
			leases: [lease("0f8fad5b-d9cb-469f-a165-70867728950e", "running")],
			onTick: (fake) => {
				// The job finishes ten minutes into the drain.
				if (fake.nowMs >= (recordedAdvert?.sinceMs ?? 0) + 10 * 60_000)
					fake.leases = fake.leases.map((entry) =>
						create(LeaseSchema, { ...entry, state: "completed" }),
					);
			},
		});
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const outcome = await resolver.reconcile(request(TARGET), transport);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.controllerDigest).toBe(digestOf(TARGET));
		expect(outcome.diagnostics[0]).toContain(digestOf(PREVIOUS));
		expect(host.calls).not.toContain("STOPPED-WITH-JOBS-IN-FLIGHT");
		const pause = host.calls.indexOf("pause");
		const stop = host.calls.findIndex((call) => call.startsWith("stop"));
		expect(pause).toBeGreaterThanOrEqual(0);
		expect(stop).toBeGreaterThan(pause);
		expect(host.admission).toBe(true);
	});

	it("refuses at the drain deadline with the controller unchanged and admission reopened", async () => {
		const host = new FakeHost({
			running: PREVIOUS,
			leases: [lease("0f8fad5b-d9cb-469f-a165-70867728950e", "running")],
		});
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const error = await refusal(
			resolver.reconcile(
				request(TARGET, { drainDeadlineMs: 120_000 }),
				transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(/^runner-host-drain-deadline: 1 job/u);
		expect(host.calls.some((call) => call.startsWith("stop"))).toBe(false);
		expect(host.runningController()?.image).toBe(PREVIOUS);
		expect(host.admission).toBe(true);
	});

	it("restores the previous digest when the new controller is not observed serving", async () => {
		const host = new FakeHost({ running: PREVIOUS, unhealthy: [TARGET] });
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const error = await refusal(resolver.reconcile(request(TARGET), transport));
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(/^runner-host-verify-failed: /u);
		expect(error.message).toContain(
			`restored and observed the previous controller ${digestOf(PREVIOUS)}`,
		);
		expect(host.runningController()?.image).toBe(
			`ghcr.io/hobo-labs/hobo/hobo-ci-worker@${digestOf(PREVIOUS)}`,
		);
		expect(host.admission).toBe(true);
	});

	it("leaves a failing new controller serving when it already holds a job", async () => {
		const host = new FakeHost({
			running: PREVIOUS,
			unhealthy: [TARGET],
			onTick: (fake) => {
				// The new controller picks up a job while it is being verified.
				if (
					fake.runningController()?.image === TARGET &&
					fake.leases.length === 0
				)
					fake.leases = [
						lease("1f8fad5b-d9cb-469f-a165-70867728950e", "running"),
					];
			},
		});
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const error = await refusal(resolver.reconcile(request(TARGET), transport));
		expect(error.message).toContain("left serving rather than stopped");
		expect(host.runningController()?.image).toBe(TARGET);
		expect(host.calls).not.toContain("STOPPED-WITH-JOBS-IN-FLIGHT");
		expect(host.admission).toBe(true);
	});

	it("refuses a failed pull before draining, so the host keeps serving", async () => {
		const host = new FakeHost({ running: PREVIOUS, unpullable: [TARGET] });
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const error = await refusal(resolver.reconcile(request(TARGET), transport));
		expect(error.message).toMatch(/^runner-host-pull-failed: /u);
		expect(host.calls).not.toContain("pause");
		expect(host.runningController()?.image).toBe(PREVIOUS);
	});

	it("refuses two running controllers rather than guess which holds jobs", async () => {
		const host = new FakeHost({ running: PREVIOUS });
		host.images.add(TARGET);
		host.containers.set("d".repeat(64), {
			name: controllerContainerName(digestOf(TARGET)),
			containerId: "d".repeat(64),
			state: "running",
			image: TARGET,
		});
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const error = await refusal(resolver.reconcile(request(TARGET), transport));
		expect(error.message).toMatch(/^runner-host-ambiguous: 2 controllers/u);
	});

	it("a local runner is not serving until a registered runner is online", async () => {
		const host = new FakeHost({ running: TARGET });
		const resolver = createRunnerHostResolver(
			host.resolverOptions({ hostKind: "local-runner" }),
		);
		const error = await refusal(resolver.reconcile(request(TARGET), transport));
		expect(error.message).toMatch(/^runner-host-target-unobserved: /u);
		expect(error.message).toContain("no registered runner is online");
	});
});

describe("runner-host realizer: observe and delete", () => {
	it("reads the controller digest, job counts (retained) and claims", async () => {
		const host = new FakeHost({
			running: PREVIOUS,
			leases: [lease("0f8fad5b-d9cb-469f-a165-70867728950e", "running")],
		});
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const observed = await resolver.read?.(request(TARGET), transport);
		expect(observed?.outputs.controllerDigest).toBe(digestOf(PREVIOUS));
		expect(observed?.outputs.inFlightJobs).toBe(1);
		expect(observed?.outputs.busyRunners).toBe(1);
		expect(observed?.diagnostics).toEqual([
			`controller ${digestOf(PREVIOUS)} observed serving`,
		]);
		const report = runnerHostCampReport(
			observed ?? expect.fail("no outcome"),
			host.nowMs,
		);
		expect(report.resource.healthy).toBe(true);
		expect(report.resource.retained).toEqual([...RUNNER_HOST_RETAINED_FIELDS]);
		expect(report.resource.attributes.inFlightJobs).toBe("1");
		expect(report.claims.map((claim) => [claim.name, claim.value])).toEqual([
			["capacity", "4"],
			["platform", "linux/x64"],
		]);
	});

	it("reads nothing on a host with no controller", async () => {
		const host = new FakeHost();
		const resolver = createRunnerHostResolver(host.resolverOptions());
		expect(await resolver.read?.(request(TARGET), transport)).toBeUndefined();
	});

	it("deletes only after the drain", async () => {
		const host = new FakeHost({ running: PREVIOUS });
		const resolver = createRunnerHostResolver(host.resolverOptions());
		await resolver.delete(request(PREVIOUS), transport);
		expect(host.runningController()).toBeUndefined();
		expect(host.calls.indexOf("pause")).toBeLessThan(
			host.calls.findIndex((call) => call.startsWith("stop")),
		);
	});
});

describe("runner-host realizer: typed refusals", () => {
	it("refuses a host without the container interface, naming what is missing", async () => {
		const host = new FakeHost();
		const ports = host.ports();
		const partial: RunnerHostPorts = {
			jobs: ports.jobs,
			containers: Object.fromEntries(
				Object.entries(ports.containers ?? {}).filter(
					([name]) => name !== "pull",
				),
			),
		};
		expect(runnerHostInterfaceGaps(partial)).toEqual(["containers.pull"]);
		expect(runnerHostInterfaceGaps({})).toHaveLength(13);
		const resolver = createRunnerHostResolver(
			host.resolverOptions({ host: partial }),
		);
		const error = await refusal(resolver.reconcile(request(TARGET), transport));
		expect(error.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(error.productId).toBe(RUNNER_HOST_PRODUCT_ID);
		expect(error.message).toMatch(
			/^runner-host-interface-missing: this host has no containers\.pull;/u,
		);
		expect(host.calls).toEqual([]);
	});

	it("refuses an image not pinned by digest, another host, and another product", async () => {
		const host = new FakeHost();
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const tagged = await refusal(
			resolver.reconcile(
				request("ghcr.io/hobo-labs/hobo/hobo-ci-worker:release-1"),
				transport,
			),
		);
		expect(tagged.message).toMatch(/^runner-host-desired-invalid: image: /u);
		const other = await refusal(
			resolver.reconcile(
				runnerHostResolveRequest({
					campId: "hobo-ci-runners/mesh-a",
					image: TARGET,
					credentialRef: CREDENTIAL_REF,
				}),
				transport,
			),
		);
		expect(other.message).toMatch(/^runner-host-scope-mismatch: /u);
		const foreign: ResolveRequest = {
			...request(TARGET),
			ref: { slot: "service", productId: "railway.service/v1", logicalId: "x" },
		};
		const product = await refusal(resolver.reconcile(foreign, transport));
		expect(product.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(runnerHostProductRefusal(RUNNER_HOST_PRODUCT_ID)).toBeUndefined();
		expect(host.calls).toEqual([]);
	});

	it("never carries credential material: env keys that read as secrets are refused, the ref never echoes", async () => {
		expect(() =>
			request(TARGET, {
				config: { command: [], env: { GITHUB_TOKEN: "x" }, volumes: [] },
			}),
		).toThrow(/RESOLVER_CREDENTIAL_NOT_A_REF|credential/u);
		const host = new FakeHost();
		const resolver = createRunnerHostResolver(host.resolverOptions());
		const outcome = await resolver.reconcile(request(TARGET), transport);
		expect(JSON.stringify(outcome)).not.toContain("HOBO_CI_GHCR_READ_TOKEN");
		const error = await refusal(
			createRunnerHostResolver(
				new FakeHost({ unpullable: [TARGET] }).resolverOptions(),
			).reconcile(request(TARGET), transport),
		);
		expect(error.message).not.toContain("HOBO_CI_GHCR_READ_TOKEN");
	});

	it("refuses a Camp outside the runner fleet Yard", () => {
		expect(() =>
			runnerHostResolveRequest({
				campId: "prod/eu-1",
				image: TARGET,
				credentialRef: CREDENTIAL_REF,
			}),
		).toThrow(/^runner-host-camp-unbound: /u);
	});
});

describe("runner-host realizer: wiring", () => {
	it("binds the runner fleet's Camps to the registered product", () => {
		const host = new FakeHost();
		const registry = runnerHostResolverRegistry(host.resolverOptions());
		const resolver = registry.get(RUNNER_HOST_PRODUCT_ID);
		expect(resolver?.providerId).toBe("hobo-ci");
		expect(resolver?.directives).toEqual(["drainDeadlineMs"]);
		expect(RUNNER_HOST_REALIZER_BINDING).toMatchObject({
			campSet: "hobo-ci-runner-fleet",
			yard: "hobo-ci-runners",
			productId: RUNNER_HOST_PRODUCT_ID,
		});
		expect(runnerHostIdForCamp("hobo-ci-runners/box")).toBe("box");
		expect(runnerHostIdForCamp("other/box")).toBeUndefined();
	});

	it("declares no traffic routing: kind other and every offering absent", () => {
		expect(RUNNER_HOST_TRAFFIC_ROUTING_PROFILE.provider).toBe("other");
		expect(RUNNER_HOST_TRAFFIC_ROUTING_PROFILE.offerings).toEqual([]);
		expect(RUNNER_HOST_TRAFFIC_ROUTING_ABSENT).toHaveLength(17);
	});
});

const LIVE = process.env.HOBO_CI_RUNNER_HOST_LIVE_DOCKER === "1";

describe.skipIf(!LIVE)(
	"live lane: observe a real Docker engine (set HOBO_CI_RUNNER_HOST_LIVE_DOCKER=1)",
	() => {
		it("reads this host's controller through the CLI Docker driver", async () => {
			const docker = createCliDockerDriver({});
			const resolver = createRunnerHostResolver({
				hostId: "box",
				hostKind: "box-worker",
				host: {
					containers: { ...docker, pull: async () => undefined },
					jobs: {
						leases: async () => [],
						runners: async () => [],
						meshAdvert: async () => undefined,
						pauseAdmission: async () => undefined,
						resumeAdmission: async () => undefined,
					},
				},
			});
			const observed = await resolver.read?.(request(TARGET), transport);
			// A host with no controller reads undefined; one with a controller
			// reports its digest. Either way nothing is changed.
			if (observed)
				expect(observed.outputs.controllerDigest).toMatch(/^sha256:/u);
		});
	},
);
