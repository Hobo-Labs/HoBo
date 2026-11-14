// A runner host whose controller is a process its worker daemon supervises,
// played across the process boundary through the worker's data directory:
// the real supervisor (`createControllerSupervisor`) with fake children, a
// worker that rewrites its advert (naming its controller digest) on every
// beat, and, for a local runner, the GitHub presence its controller reports.
// The agent's default ports (`createControllerProcessPort`,
// `createWorkerHostJobs`) read and drive it; `tick` is one pass of the host.
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	createControllerSupervisor,
	RUNNER_IMAGE_ARTIFACT,
	RUNNER_RELEASE_ARTIFACTS,
	runnerHostRealizationParameters,
	type WorkerHostFiles,
	workerAdmissionPaused,
	workerHostFiles,
	writeWorkerMeshAdvert,
	writeWorkerRunnerPresence,
} from "@hobo/ci-gh-actions";

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
			hostKind?: "box-worker" | "local-runner";
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
		const local = this.options.hostKind === "local-runner";
		if (pid === undefined || !child) {
			await rm(this.files.meshAdvert, { force: true });
			if (local)
				await writeWorkerRunnerPresence(this.files, {
					observedAtMs: this.nowMs,
					runners: [],
				});
			return;
		}
		const open = !workerAdmissionPaused(this.files);
		await writeWorkerMeshAdvert(
			this.files,
			{
				id: "box",
				freeSlots: local ? 1 : 3,
				totalSlots: local ? 1 : 4,
				healthy: open && !this.options.unhealthy?.includes(child.digest),
				labels: local ? ["hobo-local-host"] : ["hobo", "hobo-trunk"],
				validUntilMs: this.nowMs + 60_000,
				sinceMs: this.started.find((entry) => entry.pid === pid)?.atMs ?? 0,
				platform: { os: "linux", arch: "x64" },
			},
			child.digest,
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
