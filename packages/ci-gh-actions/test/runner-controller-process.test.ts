// The runner controller as a supervised process: the agent's control port
// (releases staged and verified by digest, a desired-release request, the
// supervisor's status), the daemon-side supervisor (swap, supervised restart,
// crash limit, a tampered release refused), and the runner-host realizer
// driving both through the worker's data directory. Offline: the supervisor's
// children are fakes, except one real `node` child to prove the launcher.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { type HttpTransport, ResolverError } from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ControllerChild,
	type ControllerLauncher,
	controllerReleasePath,
	createControllerProcessPort,
	createControllerSupervisor,
	nodeControllerLauncher,
	readControllerStatus,
	releaseDigestOf,
	releaseFetchFrom,
} from "../src/runner-controller-process.js";
import {
	createRunnerHostResolver,
	type RunnerHostPorts,
	runnerHostInterfaceGaps,
	runnerHostResolveRequest,
} from "../src/runner-host-realizer.js";
import {
	createWorkerHostJobs,
	type WorkerHostFiles,
	workerAdmissionPaused,
	workerHostFiles,
	writeWorkerMeshAdvert,
} from "../src/runner-host-worker-jobs.js";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});
async function freshDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "runner-controller-process-"));
	dirs.push(dir);
	return dir;
}

const sha256 = (bytes: string | Uint8Array) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const REPOSITORY = "releases.hobo.test/hobo-ci-worker";
const transport: HttpTransport = async () => {
	throw new Error("the runner-host realizer makes no HTTP call");
};

/** A release source directory with one `<hex>.mjs` per release body. */
async function releaseSource(
	bodies: readonly string[],
): Promise<
	Readonly<{ source: string; images: readonly string[]; digests: string[] }>
> {
	const source = join(await freshDir(), "source");
	await mkdir(source);
	const digests: string[] = [];
	for (const body of bodies) {
		const digest = sha256(body);
		digests.push(digest);
		await writeFile(join(source, `${digest.slice(7)}.mjs`), body);
	}
	return {
		source,
		digests,
		images: digests.map((digest) => `${REPOSITORY}@${digest}`),
	};
}

type FakeChild = ControllerChild & {
	digest: string;
	signals: string[];
	exit(code: number | null): void;
	exitCode: number | null | undefined;
};

/** A launcher whose children are fakes; `stubborn` children ignore SIGTERM. */
function fakeLauncher(options: { stubborn?: readonly string[] } = {}) {
	const children: FakeChild[] = [];
	let nextPid = 4100;
	const launch: ControllerLauncher = ({ entry, digest }) => {
		let settle: (code: number | null) => void = () => undefined;
		const exited = new Promise<number | null>((resolve) => {
			settle = resolve;
		});
		const child: FakeChild = {
			pid: nextPid++,
			digest,
			exited,
			signals: [],
			exitCode: undefined,
			exit(code) {
				if (child.exitCode !== undefined) return;
				child.exitCode = code;
				settle(code);
			},
			terminate(signal) {
				child.signals.push(signal);
				if (signal === "SIGKILL" || !options.stubborn?.includes(digest))
					child.exit(signal === "SIGKILL" ? null : 0);
			},
		};
		expect(entry).toMatch(/controller-releases\/[0-9a-f]{64}\.mjs$/u);
		children.push(child);
		return child;
	};
	return {
		launch,
		children,
		live: () => children.filter((child) => child.exitCode === undefined),
	};
}

describe("process controller port (agent side)", () => {
	it("stages a release only when its bytes hash to the digest it was asked for", async () => {
		const files = workerHostFiles(join(await freshDir(), "worker.sqlite"));
		const { source, images, digests } = await releaseSource([
			"export const v = 1;\n",
		]);
		const fetched: string[] = [];
		const port = createControllerProcessPort({
			files,
			fetchRelease: async (reference, digest) => {
				fetched.push(reference);
				return releaseFetchFrom(source)(reference, digest);
			},
		});
		const image = images[0] ?? "";
		await port.stage(image);
		expect(
			await readFile(controllerReleasePath(files, digests[0] ?? ""), "utf8"),
		).toBe("export const v = 1;\n");
		// Idempotent by digest: a verified release is not fetched again.
		await port.stage(image);
		expect(fetched).toEqual([image]);

		// A release whose bytes do not match is refused and nothing is kept.
		const lying = `${REPOSITORY}@sha256:${"e".repeat(64)}`;
		const liar = createControllerProcessPort({
			files,
			fetchRelease: async () => new TextEncoder().encode("tampered"),
		});
		await expect(liar.stage(lying)).rejects.toThrow(
			/release digest mismatch: fetched sha256:[0-9a-f]{64}, expected sha256:e{64}/u,
		);
		expect(
			existsSync(controllerReleasePath(files, `sha256:${"e".repeat(64)}`)),
		).toBe(false);
		await expect(liar.stage("not-pinned:latest")).rejects.toThrow(
			"not pinned by @sha256 digest",
		);
	});

	it("asks the supervisor by generation, only for staged releases", async () => {
		const files = workerHostFiles(join(await freshDir(), "worker.sqlite"));
		const { source, images, digests } = await releaseSource(["a", "b"]);
		const port = createControllerProcessPort({
			files,
			fetchRelease: releaseFetchFrom(source),
			now: () => 1_000,
		});
		await expect(port.run(digests[1])).rejects.toThrow("is not staged");
		await port.stage(images[0] ?? "");
		expect(await port.run(digests[0])).toBe(1);
		expect(await port.run(undefined)).toBe(2);
		expect(JSON.parse(await readFile(files.controllerDesired, "utf8"))).toEqual(
			{ generation: 2, digest: null, requestedAtMs: 1_000 },
		);
		expect(await port.status()).toBeUndefined();
	});

	it("fetches releases over https only, never with credentials in the URL", async () => {
		expect(() => releaseFetchFrom("http://releases.hobo.test/")).toThrow(
			"https://",
		);
		expect(() =>
			releaseFetchFrom("https://user:secret@releases.hobo.test/"),
		).toThrow("no credentials");
		const asked: string[] = [];
		const fetchRelease = releaseFetchFrom(
			"https://releases.hobo.test/worker",
			async (url) => {
				asked.push(String(url));
				return new Response("body");
			},
		);
		const digest = sha256("body");
		expect(
			new TextDecoder().decode(await fetchRelease("ignored", digest)),
		).toBe("body");
		expect(asked).toEqual([
			`https://releases.hobo.test/worker/${digest.slice(7)}.mjs`,
		]);
		expect(releaseDigestOf(`${REPOSITORY}@${digest}`)).toBe(digest);
	});
});

describe("controller supervisor (daemon side)", () => {
	async function staged(bodies: readonly string[]) {
		const files = workerHostFiles(join(await freshDir(), "worker.sqlite"));
		const { source, images, digests } = await releaseSource(bodies);
		const port = createControllerProcessPort({
			files,
			fetchRelease: releaseFetchFrom(source),
		});
		for (const image of images) await port.stage(image);
		return { files, port, digests };
	}

	it("starts the requested release, swaps it on a new request, and stops on none", async () => {
		const { files, port, digests } = await staged(["v1", "v2"]);
		const launcher = fakeLauncher();
		const supervisor = createControllerSupervisor({
			files,
			launch: launcher.launch,
		});
		await supervisor.tick();
		expect((await readControllerStatus(files))?.state).toBe("stopped");

		const first = await port.run(digests[0]);
		await supervisor.tick();
		expect(await port.status()).toMatchObject({
			generation: first,
			digest: digests[0],
			state: "running",
			pid: launcher.children[0]?.pid,
		});

		const second = await port.run(digests[1]);
		await supervisor.tick();
		expect(launcher.children[0]?.signals).toEqual(["SIGTERM"]);
		expect(launcher.live().map((child) => child.digest)).toEqual([digests[1]]);
		expect(await port.status()).toMatchObject({
			generation: second,
			digest: digests[1],
			state: "running",
		});

		const stop = await port.run(undefined);
		await supervisor.tick();
		expect(launcher.live()).toEqual([]);
		expect(await port.status()).toEqual({ generation: stop, state: "stopped" });
	});

	it("never starts a release whose staged bytes no longer hash to its digest", async () => {
		const { files, port, digests } = await staged(["v1"]);
		const digest = digests[0] ?? "";
		await port.run(digest);
		await writeFile(controllerReleasePath(files, digest), "tampered on disk");
		const launcher = fakeLauncher();
		const supervisor = createControllerSupervisor({
			files,
			launch: launcher.launch,
		});
		await supervisor.tick();
		expect(launcher.children).toEqual([]);
		const status = await port.status();
		expect(status?.state).toBe("failed");
		expect(status?.reason).toContain("does not hash to its digest");
	});

	it("restarts a child that exits on its own, then reports failed past the crash limit", async () => {
		const { files, port, digests } = await staged(["v1"]);
		const launcher = fakeLauncher();
		let nowMs = 0;
		const supervisor = createControllerSupervisor({
			files,
			launch: launcher.launch,
			now: () => nowMs,
			crashLimit: 2,
		});
		await port.run(digests[0]);
		await supervisor.tick();
		for (let crash = 1; crash <= 2; crash++) {
			launcher.live()[0]?.exit(1);
			await pause(0);
			nowMs += 1_000;
			await supervisor.tick();
			expect((await port.status())?.state).toBe("running");
		}
		expect(launcher.children).toHaveLength(3);
		launcher.live()[0]?.exit(1);
		await pause(0);
		await supervisor.tick();
		const status = await port.status();
		expect(status?.state).toBe("failed");
		expect(status?.reason).toContain("exited 3 times");
		expect(launcher.live()).toEqual([]);
	});

	it("kills a child that ignores SIGTERM past the stop deadline", async () => {
		const { files, port, digests } = await staged(["v1", "v2"]);
		const launcher = fakeLauncher({ stubborn: [digests[0] ?? ""] });
		const supervisor = createControllerSupervisor({
			files,
			launch: launcher.launch,
			stopTimeoutMs: 5,
			sleep: (ms) => pause(ms),
		});
		await port.run(digests[0]);
		await supervisor.tick();
		await port.run(digests[1]);
		await supervisor.tick();
		expect(launcher.children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect((await port.status())?.digest).toBe(digests[1]);
	});

	it("starts a real release with node, no shell, and the digest in its env", async () => {
		const body = `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], process.env.HOBO_CI_CONTROLLER_DIGEST ?? "");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;
		const { files, port, digests } = await staged([body]);
		const marker = join(await freshDir(), "started");
		const supervisor = createControllerSupervisor({
			files,
			launch: nodeControllerLauncher({ args: [marker], env: {} }),
		});
		await port.run(digests[0]);
		await supervisor.tick();
		const pid = supervisor.childPid();
		expect(pid).toBeGreaterThan(0);
		for (let i = 0; i < 100 && !existsSync(marker); i++) await pause(20);
		expect(await readFile(marker, "utf8")).toBe(digests[0]);
		await supervisor.shutdown();
		expect(supervisor.childPid()).toBeUndefined();
		expect((await port.status())?.state).toBe("stopped");
	});
});

/**
 * A box worker under its daemon's supervisor, as the agent sees it across the
 * process boundary: every supervisor tick and worker beat runs when the
 * realizer waits. The worker advertises its controller digest, healthy unless
 * the agent closed admission or the release is in `unhealthy`.
 */
async function supervisedHost(
	options: {
		unhealthy?: (digests: string[]) => readonly string[];
		/** A worker build that does not name its controller digest in its advert. */
		anonymous?: boolean;
	} = {},
) {
	const files = workerHostFiles(join(await freshDir(), "worker.sqlite"));
	const releases = await releaseSource([
		"export const v = 1;\n",
		"export const v = 2;\n",
		"export const v = 3; // never healthy\n",
	]);
	const unhealthy = new Set(options.unhealthy?.(releases.digests) ?? []);
	const launcher = fakeLauncher();
	let nowMs = Date.parse("2026-11-13T10:00:00.000Z");
	const supervisor = createControllerSupervisor({
		files,
		launch: launcher.launch,
		now: () => nowMs,
	});
	const started = new Map<number, number>();
	async function beat(): Promise<void> {
		await supervisor.tick();
		const child = launcher.live()[0];
		if (!child?.pid) {
			await rm(files.meshAdvert, { force: true });
			return;
		}
		if (!started.has(child.pid)) started.set(child.pid, nowMs);
		await writeWorkerMeshAdvert(
			files,
			{
				id: "box",
				freeSlots: 3,
				totalSlots: 4,
				healthy: !workerAdmissionPaused(files) && !unhealthy.has(child.digest),
				labels: ["hobo", "hobo-trunk"],
				validUntilMs: nowMs + 60_000,
				sinceMs: started.get(child.pid) ?? nowMs,
				platform: { os: "linux", arch: "x64" },
			},
			options.anonymous ? undefined : child.digest,
		);
	}
	const process = createControllerProcessPort({
		files,
		fetchRelease: releaseFetchFrom(releases.source),
		now: () => nowMs,
	});
	const ports: RunnerHostPorts = {
		process,
		jobs: createWorkerHostJobs({
			files,
			hostKind: "box-worker",
			now: () => nowMs,
		}),
	};
	const resolver = createRunnerHostResolver({
		hostId: "box",
		hostKind: "box-worker",
		host: ports,
		now: () => nowMs,
		sleep: async (ms) => {
			nowMs += ms;
			await beat();
		},
		pollIntervalMs: 5_000,
		verifyDeadlineMs: 60_000,
		drainDeadlineMs: 60_000,
	});
	return { files, releases, launcher, supervisor, resolver, beat, ports };
}

const request = (image: string, config?: { env: Record<string, string> }) =>
	runnerHostResolveRequest({
		campId: "hobo-ci-runners/box",
		image,
		credentialRef: "env://HOBO_CI_RELEASE_READ",
		...(config ? { config } : undefined),
	});

describe("runner-host realizer: a controller that runs as a process", () => {
	it("wires the process port in place of the container port", () => {
		const files = workerHostFiles("/var/lib/hobo-ci/worker.sqlite");
		const jobs = createWorkerHostJobs({ files, hostKind: "box-worker" });
		expect(runnerHostInterfaceGaps({ process: {}, jobs })).toEqual([
			"process.run",
			"process.stage",
			"process.status",
		]);
		expect(
			runnerHostInterfaceGaps({
				process: createControllerProcessPort({
					files,
					fetchRelease: async () => new Uint8Array(),
				}),
				jobs,
			}),
		).toEqual([]);
	});

	it("starts, then swaps by digest under the supervisor, verified by the advert at the new version", async () => {
		const host = await supervisedHost();
		const [v1, v2] = host.releases.images;
		const [d1, d2] = host.releases.digests;
		const created = await host.resolver.reconcile(request(v1 ?? ""), transport);
		expect(created.action).toBe("create");
		expect(created.outputs.controllerDigest).toBe(d1);
		expect(created.outputs.containerId).toBe(
			`pid:${host.launcher.children[0]?.pid}`,
		);
		expect(created.outputs.meshAdvert).toMatchObject({
			controllerDigest: d1,
			healthy: true,
		});

		const updated = await host.resolver.reconcile(request(v2 ?? ""), transport);
		expect(updated.action).toBe("update");
		expect(updated.outputs.controllerDigest).toBe(d2);
		expect(updated.diagnostics[0]).toContain(`${d1} -> ${d2}`);
		expect(host.launcher.live().map((child) => child.digest)).toEqual([d2]);
		expect(host.launcher.children[0]?.signals).toEqual(["SIGTERM"]);
		// Admission reopened; the release was fetched and verified by digest.
		expect(workerAdmissionPaused(host.files)).toBe(false);
		expect(
			await readFile(controllerReleasePath(host.files, d2 ?? ""), "utf8"),
		).toBe("export const v = 2;\n");

		// Idempotent: the observed host at the target is a noop, no new child.
		const again = await host.resolver.reconcile(request(v2 ?? ""), transport);
		expect(again.action).toBe("noop");
		expect(host.launcher.children).toHaveLength(2);
		const read = await host.resolver.read?.(request(v2 ?? ""), transport);
		expect(read?.outputs.serving).toBe(true);
	});

	it("restores the previous release when the new one never advertises healthy", async () => {
		const host = await supervisedHost({ unhealthy: (d) => [d[2] ?? ""] });
		const [v1, , broken] = host.releases.images;
		const [d1, , d3] = host.releases.digests;
		await host.resolver.reconcile(request(v1 ?? ""), transport);
		let error: unknown;
		try {
			await host.resolver.reconcile(request(broken ?? ""), transport);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ResolverError);
		const message = error instanceof Error ? error.message : "";
		expect(message).toMatch(/^runner-host-verify-failed: /u);
		expect(message).toContain(`${d3} was not observed serving`);
		expect(message).toContain(
			`restored and observed the previous controller ${d1}`,
		);
		expect(host.launcher.live().map((child) => child.digest)).toEqual([d1]);
		expect((await readControllerStatus(host.files))?.digest).toBe(d1);
		expect(workerAdmissionPaused(host.files)).toBe(false);
	});

	it("does not take an advert that names no controller digest as the new version's", async () => {
		const host = await supervisedHost({ anonymous: true });
		await expect(
			host.resolver.reconcile(
				request(host.releases.images[0] ?? ""),
				transport,
			),
		).rejects.toThrow(/the mesh advert names no controller digest/u);
	});

	it("refuses a release that does not verify, keeping the running one", async () => {
		const host = await supervisedHost();
		const [v1] = host.releases.images;
		await host.resolver.reconcile(request(v1 ?? ""), transport);
		const unknown = `${REPOSITORY}@sha256:${"f".repeat(64)}`;
		await expect(
			host.resolver.reconcile(request(unknown), transport),
		).rejects.toThrow(/^runner-host-stage-failed: /u);
		expect(host.launcher.live()).toHaveLength(1);
		expect(workerAdmissionPaused(host.files)).toBe(false);
	});

	it("refuses container settings a supervised process cannot take", async () => {
		const host = await supervisedHost();
		await expect(
			host.resolver.reconcile(
				request(host.releases.images[0] ?? "", { env: { A: "1" } }),
				transport,
			),
		).rejects.toThrow(/^runner-host-config-unsupported: .*env/u);
		expect(host.launcher.children).toEqual([]);
	});
});

export type { WorkerHostFiles };
