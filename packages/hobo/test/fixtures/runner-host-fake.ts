// A runner host as the runner-host realizer sees it, offline: the container
// engine (`--rm` semantics: a stopped controller is gone), the worker's
// leases, GitHub runner presence and the host's own mesh advert, derived from
// whichever controller is running. Images listed in `unhealthy` start but
// never advertise healthy, which is how a failed verify is reproduced.
//
// With `worker` set the fake plays the box worker across the process
// boundary instead: it hands out only the container port, writes the advert
// the running controller's worker would write into the worker's data
// directory, and honours the admission marker the agent places there. The
// agent's own job ports (`createWorkerHostJobs`) then read the host.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
	type WorkerHostFiles,
	writeWorkerMeshAdvert,
} from "@hobo/ci-gh-actions";
import type { RunnerHostPorts } from "@hobo/ci-gh-actions/runner-host";
import {
	createResolvedDeploymentSet,
	DEPLOYMENT_PLAN_SCHEMA,
} from "@hobo/cloud";

/** A resolved Set whose plan has the runner-host row for `image` (what a promotion would resolve). */
export function runnerHostResolvedSet(
	input: Readonly<{
		campId: string;
		image?: string;
		/** The row's whole realization parameters (`runnerHostRealizationParameters`), in place of `image`. */
		parameters?: Readonly<Record<string, string>>;
		tenant?: string;
	}>,
) {
	const parameters =
		input.parameters ?? (input.image ? { image: input.image } : undefined);
	return createResolvedDeploymentSet({
		tenant: input.tenant ?? "local",
		environment: "ci",
		campId: input.campId,
		plan: {
			schema: DEPLOYMENT_PLAN_SCHEMA,
			resources: [
				{
					name: "runner-controller",
					port: "compute",
					provider: "self-hosted",
					deps: [],
					...(parameters
						? {
								productId: "hobo-ci.runner-host/v1",
								realizationParameters: { ...parameters },
							}
						: undefined),
				},
			],
			dependencyOrder: ["runner-controller"],
			objective: "pinned",
		},
		matches: [
			{
				resource: "runner-controller",
				providerId: "self-hosted",
				port: "compute",
				rationale: "the runner host's own engine",
			},
		],
		gatekeeper: {
			decision: "allow",
			gatekeeperDecisionId: "gate-test",
			obligations: [],
			decidedAt: "2026-11-12T10:00:00.000Z",
		},
	});
}

export const REPOSITORY = "ghcr.io/hobo-labs/hobo/hobo-ci-worker";
export const imageAt = (hex: string) =>
	`${REPOSITORY}@sha256:${hex.repeat(64 / hex.length)}`;
export const digestOf = (image: string) => image.slice(image.indexOf("@") + 1);
const CONTROLLER = "hoboci-runner-controller-";

type Container = {
	name: string;
	containerId: string;
	state: "created" | "running";
	image: string;
	startedAtMs?: number;
};

export class FakeRunnerHost {
	nowMs: number;
	readonly calls: string[] = [];
	readonly images = new Set<string>();
	readonly containers = new Map<string, Container>();
	#admission = true;
	nextId = 1;

	constructor(
		readonly options: Readonly<{
			hostId?: string;
			running?: string;
			unhealthy?: readonly string[];
			labels?: readonly string[];
			startMs?: number;
			/** Play the worker through its data directory (see the file comment). */
			worker?: WorkerHostFiles;
		}> = {},
	) {
		this.nowMs = options.startMs ?? Date.parse("2026-11-12T10:00:00.000Z");
		if (options.running) {
			this.images.add(options.running);
			const containerId = "a".repeat(64);
			this.containers.set(containerId, {
				name: `${CONTROLLER}${digestOf(options.running).slice("sha256:".length)}`,
				containerId,
				state: "running",
				image: options.running,
				startedAtMs: this.nowMs - 60_000,
			});
		}
	}

	runningImage(): string | undefined {
		return [...this.containers.values()].find(
			(c) => c.state === "running" && c.name.startsWith(CONTROLLER),
		)?.image;
	}

	/** Whether the worker admits jobs: the agent's marker when `worker` is set. */
	get admission(): boolean {
		const worker = this.options.worker;
		return worker ? !existsSync(worker.admissionPaused) : this.#admission;
	}

	set admission(open: boolean) {
		this.#admission = open;
	}

	/** The host's own advert, as the running controller's worker makes it. */
	advert() {
		const live = [...this.containers.values()].find(
			(c) => c.state === "running" && c.name.startsWith(CONTROLLER),
		);
		if (!live) return undefined;
		return {
			id: this.options.hostId ?? "box",
			freeSlots: 3,
			totalSlots: 4,
			healthy: this.admission && !this.options.unhealthy?.includes(live.image),
			labels: [...(this.options.labels ?? ["hobo", "hobo-trunk"])],
			validUntilMs: this.nowMs + 60_000,
			sinceMs: live.startedAtMs ?? 0,
			platform: { os: "linux", arch: "x64" },
		};
	}

	/** The worker's mesh beat: rewrite (or, with no controller, remove) its advert file. */
	async beat(): Promise<void> {
		const worker = this.options.worker;
		if (!worker) return;
		const advert = this.advert();
		if (advert) await writeWorkerMeshAdvert(worker, advert);
		else await rm(worker.meshAdvert, { force: true });
	}

	ports(): RunnerHostPorts {
		const ports = portsOf(this);
		return this.options.worker ? { containers: ports.containers } : ports;
	}
}

/** The ports a FakeRunnerHost hands the realizer. */
function portsOf(host: FakeRunnerHost): RunnerHostPorts {
	return {
		containers: {
			async listWorkerContainers() {
				return [...host.containers.values()].map(
					({ image: _i, startedAtMs: _s, ...c }) => c,
				);
			},
			async pull(image: string) {
				host.calls.push(`pull ${image}`);
				host.images.add(image);
			},
			async inspectImage(image: string) {
				if (!host.images.has(image)) throw new Error("No such image");
				return { id: digestOf(image), repoTags: [], labels: {} };
			},
			async create(spec) {
				host.calls.push(`create ${spec.image}`);
				if (!host.images.has(spec.image)) throw new Error("No such image");
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
				const container = host.containers.get(containerId);
				if (!container) throw new Error("No such container");
				container.state = "running";
				container.startedAtMs = host.nowMs;
				await host.beat();
			},
			async stop(_name: string, containerId: string) {
				host.calls.push(`stop ${host.containers.get(containerId)?.image}`);
				host.containers.delete(containerId);
				await host.beat();
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
				return [];
			},
			async runners() {
				return [];
			},
			async meshAdvert() {
				return host.advert();
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
