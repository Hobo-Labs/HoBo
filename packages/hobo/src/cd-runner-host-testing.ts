/**
 * Test doubles for the runner-host agent (`cd-agent-runner-host.ts`), used by
 * this package's `cd-*` tests only and never by the CLI: a runner host as the
 * runner-host realizer sees it, offline, reporting itself as a `DEVICE`
 * member of fleet `hobo` through its own fleet `Observation`.
 *
 * - `FakeRunnerHost`: the container engine (`--rm` semantics: a stopped
 *   controller is gone), the worker's leases, GitHub runner presence and the
 *   host's own observation, derived from whichever controller is running.
 *   Images listed in `unhealthy` start but never report healthy, which is how
 *   a failed verify is reproduced. With `worker` set it plays the box worker
 *   across the process boundary instead: it hands out only the container
 *   port, writes the observation the host's fleet agent would write into the
 *   worker's data directory, and honours the admission marker the agent
 *   places there. The agent's own job ports (`createWorkerHostJobs`) then
 *   read the host.
 * - `SupervisedRunnerHost`: a host whose controller is a process its worker
 *   daemon supervises, played through the worker's data directory: the real
 *   supervisor (`createControllerSupervisor`) with fake children, a fleet
 *   agent that rewrites its observation (naming its controller digest) on
 *   every beat, and, for a developer device, the GitHub presence its
 *   controller reports. `tick` is one pass of the host.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	createControllerSupervisor,
	RUNNER_IMAGE_ARTIFACT,
	RUNNER_RELEASE_ARTIFACTS,
	runnerHostRealizationParameters,
	workerAdmissionPaused,
	writeWorkerRunnerPresence,
} from "@hobo/ci-gh-actions";
import {
	type RunnerHostPorts,
	type WorkerHostFiles,
	workerHostFiles,
	writeWorkerObservation,
} from "@hobo/ci-gh-actions/runner-host";
import { Health, type Observation, ObservationSchema } from "@hobo/fleet";

/**
 * A host's own fleet observation (observer = member), as its fleet agent
 * signs and publishes it every beat; `controllerDigest` rides as a label.
 */
export function selfObservation(
	input: Readonly<{
		memberId: string;
		healthy: boolean;
		labels: readonly string[];
		validUntilMs: number;
		sinceMs: number;
		freeSlots: number;
		totalSlots: number;
		controllerDigest?: string;
	}>,
): Observation {
	return create(ObservationSchema, {
		memberId: input.memberId,
		observerId: input.memberId,
		fleets: ["hobo"],
		health: input.healthy ? Health.REACHABLE : Health.DRAINING,
		capacity: { freeSlots: input.freeSlots, totalSlots: input.totalSlots },
		labels: [
			...input.labels,
			...(input.controllerDigest
				? [`hobo.ci/controller-digest=${input.controllerDigest}`]
				: []),
		],
		platform: { os: "linux", arch: "x64" },
		agentVersion: "1.0.0",
		since: new Date(input.sinceMs).toISOString(),
		issuedAt: new Date(input.validUntilMs - 60_000).toISOString(),
		validUntil: new Date(input.validUntilMs).toISOString(),
	});
}

const digestOf = (image: string) => image.slice(image.indexOf("@") + 1);
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

	/** The host's own fleet observation, as its fleet agent makes it while a controller runs. */
	advert(): Observation | undefined {
		const live = [...this.containers.values()].find(
			(c) => c.state === "running" && c.name.startsWith(CONTROLLER),
		);
		if (!live) return undefined;
		return selfObservation({
			memberId: `member-${this.options.hostId ?? "box"}`,
			freeSlots: 3,
			totalSlots: 4,
			healthy: this.admission && !this.options.unhealthy?.includes(live.image),
			labels: [...(this.options.labels ?? ["hobo", "hobo-trunk"])],
			validUntilMs: this.nowMs + 60_000,
			sinceMs: live.startedAtMs ?? 0,
		});
	}

	/** The fleet agent's beat: rewrite (or, with no controller, remove) the observation file. */
	async beat(): Promise<void> {
		const worker = this.options.worker;
		if (!worker) return;
		const advert = this.advert();
		if (advert) await writeWorkerObservation(worker, advert);
		else await rm(worker.observation, { force: true });
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
			async observation() {
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

export class SupervisedRunnerHost {
	nowMs = Date.parse("2026-11-13T10:00:00.000Z");
	readonly files: WorkerHostFiles;
	readonly started: { digest: string; pid: number; atMs: number }[] = [];
	readonly #live = new Map<
		number,
		{ digest: string; exit: (code: number | null) => void }
	>();
	readonly #supervisor: ReturnType<typeof createControllerSupervisor>;
	#nextPid = 7000;

	constructor(
		readonly options: Readonly<{
			dataDirectory: string;
			hostKind?: "box-worker" | "developer-device";
			unhealthy?: readonly string[];
			/** A local runner whose runner never comes online. */
			offline?: boolean;
		}>,
	) {
		this.files = workerHostFiles(join(options.dataDirectory, "worker.sqlite"));
		this.#supervisor = createControllerSupervisor({
			files: this.files,
			now: () => this.nowMs,
			launch: ({ digest }) => {
				const pid = this.#nextPid++;
				let exit: (code: number | null) => void = () => undefined;
				const exited = new Promise<number | null>((resolve) => {
					exit = resolve;
				});
				this.#live.set(pid, { digest, exit });
				this.started.push({ digest, pid, atMs: this.nowMs });
				return {
					pid,
					exited,
					terminate: () => {
						this.#live.get(pid)?.exit(0);
						this.#live.delete(pid);
					},
				};
			},
		});
	}

	/** Digests of the live children. */
	running(): string[] {
		return [...this.#live.values()].map((child) => child.digest);
	}

	/** One supervisor pass, then the live worker's beat. */
	async tick(): Promise<void> {
		await this.#supervisor.tick();
		const [pid, child] = [...this.#live.entries()][0] ?? [];
		const local = this.options.hostKind === "developer-device";
		if (pid === undefined || !child) {
			await rm(this.files.observation, { force: true });
			if (local)
				await writeWorkerRunnerPresence(this.files, {
					observedAtMs: this.nowMs,
					runners: [],
				});
			return;
		}
		const open = !workerAdmissionPaused(this.files);
		await writeWorkerObservation(
			this.files,
			selfObservation({
				memberId: "member-box",
				freeSlots: local ? 1 : 3,
				totalSlots: local ? 1 : 4,
				healthy: open && !this.options.unhealthy?.includes(child.digest),
				labels: local ? ["hobo-local-host"] : ["hobo", "hobo-trunk"],
				validUntilMs: this.nowMs + 60_000,
				sinceMs: this.started.find((entry) => entry.pid === pid)?.atMs ?? 0,
				controllerDigest: child.digest,
			}),
		);
		if (local)
			await writeWorkerRunnerPresence(this.files, {
				observedAtMs: this.nowMs,
				// Closed admission: the controller gave up its waiting runner.
				runners:
					open && !this.options.offline
						? [{ name: `hobo-local-${pid}`, status: "online", busy: false }]
						: [],
			});
	}
}

/**
 * Release bodies written as `<hex>.mjs` in `source`, as the release build
 * publishes them. Each comes back as the Freight a promotion would carry for
 * one version: the worker image, pinned by an OCI manifest digest that is not
 * the release's (as GHCR's never is), and the release under `artifact`,
 * pinned by its bytes' sha256 (`runnerFleetDelivery({releaseIndexBase})`).
 * `parameters` is the runner-host row that Freight resolves to.
 */
export async function writeReleases(
	source: string,
	bodies: readonly string[],
	artifact: string = RUNNER_RELEASE_ARTIFACTS.workerRelease,
): Promise<
	{
		digest: string;
		image: string;
		parameters: Readonly<Record<string, string>>;
	}[]
> {
	await mkdir(source, { recursive: true });
	const releases = [];
	for (const body of bodies) {
		const hex = createHash("sha256").update(body).digest("hex");
		await writeFile(join(source, `${hex}.mjs`), body);
		const manifest = createHash("sha256")
			.update(`oci manifest of ${body}`)
			.digest("hex");
		const image = `ghcr.io/hobo-labs/hobo/hobo-ci-worker@sha256:${manifest}`;
		const parameters = runnerHostRealizationParameters([
			{
				name: RUNNER_IMAGE_ARTIFACT,
				digest: `sha256:${manifest}`,
				coordinate: image,
			},
			{
				name: artifact,
				digest: `sha256:${hex}`,
				coordinate: `https://releases.hobo.test/hobo-ci/${hex}.mjs`,
			},
		]);
		if (!parameters) throw new Error("the Freight has no worker image");
		releases.push({ digest: `sha256:${hex}`, image, parameters });
	}
	return releases;
}
