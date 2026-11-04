import { describe, expect, it, vi } from "vitest";
import {
	createDepsImageEnsurer,
	type DepsImageAction,
	type DepsImageEvent,
	type DepsImageProcessRequest,
	defaultDepsRoot,
} from "../src/isolated-worker/deps-image.js";

const TOOLCHAIN = "v0123456789ab";
const KEY = `${TOOLCHAIN}-0123456789abcdef`;
const CANDIDATE = `hobo-ci-deps:${KEY}`;
const REMOTE = `ghcr.io/hobo-labs/hobo/hobo-ci-deps:${KEY}`;

function deferred() {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return {
		promise,
		release: () => {
			if (!resolve) throw new Error("deferred already released");
			resolve();
		},
	};
}

function harness() {
	let head = "a".repeat(40);
	let key = KEY;
	let now = 1_000;
	let pullFails = false;
	let buildFails = false;
	const images = new Set<string>();
	const dockerCalls: string[] = [];
	const processCalls: DepsImageProcessRequest[] = [];
	const events: DepsImageEvent[] = [];
	let build: (() => Promise<void>) | undefined;
	const options = {
		root: "/checkout",
		repository: "Hobo-Labs/HoBo",
		buildMemoryMb: 4096,
		git: { defaultBranchHead: vi.fn(async () => head) },
		fs: { depsKey: vi.fn(async () => key) },
		docker: {
			toolchain: vi.fn(async (_root: string) => TOOLCHAIN),
			imageExists: vi.fn(async (image: string) => images.has(image)),
			pull: vi.fn(async (image: string) => {
				dockerCalls.push(`pull ${image}`);
				if (pullFails) throw new Error("registry miss");
				images.add(image);
			}),
			tag: vi.fn(async (source: string, target: string) => {
				dockerCalls.push(`tag ${source} ${target}`);
				images.add(target);
			}),
		},
		processes: {
			run: vi.fn(async (request: DepsImageProcessRequest) => {
				processCalls.push(request);
				if (request.command === "nice") {
					if (build) return build();
					if (buildFails) throw new Error("build failed");
					images.add(CANDIDATE);
				}
			}),
		},
		now: () => now,
		initialRetryMs: 100,
		maxRetryMs: 400,
		onEvent: (event: DepsImageEvent) => events.push(event),
	};
	return {
		options,
		events,
		dockerCalls,
		processCalls,
		images,
		setHead: (value: string) => {
			head = value;
		},
		setKey: (value: string) => {
			key = value;
		},
		setNow: (value: number) => {
			now = value;
		},
		setPullFails: (value: boolean) => {
			pullFails = value;
		},
		setBuildFails: (value: boolean) => {
			buildFails = value;
		},
		setBuild: (value: (() => Promise<void>) | undefined) => {
			build = value;
		},
	};
}

function ensured(events: readonly DepsImageEvent[], action: DepsImageAction) {
	expect(events).toEqual([
		{ event: "hobo_ci_deps_image_ensure_started", key: KEY },
		{
			event: "hobo_ci_deps_image_ensure",
			key: KEY,
			action,
			ms: 0,
		},
	]);
}

describe("worker-owned deps image ensure", () => {
	it("defaults the deps root from the daemon module instead of its service cwd", () => {
		expect(
			defaultDepsRoot(
				"file:///srv/HoBo/packages/ci-gh-actions/scripts/isolated-worker-daemon-main.mts",
			),
		).toBe("/srv/HoBo");
	});

	it("computes the candidate key from the resolved worker toolchain", async () => {
		const fake = harness();
		await createDepsImageEnsurer(fake.options).ensure();
		expect(fake.options.docker.toolchain).toHaveBeenCalledWith("/checkout");
		expect(fake.options.fs.depsKey).toHaveBeenCalledWith(
			"/checkout",
			TOOLCHAIN,
		);
	});

	it("pulls a missing image, promotes it, and runs keep-2 GC", async () => {
		const fake = harness();
		const result = await createDepsImageEnsurer(fake.options).ensure();
		expect(result).toEqual({
			status: "ensured",
			key: KEY,
			action: "pull",
			ms: 0,
		});
		expect(fake.dockerCalls).toEqual([
			`pull ${REMOTE}`,
			`tag ${REMOTE} ${CANDIDATE}`,
			`tag ${CANDIDATE} hobo-ci-deps:local`,
		]);
		expect(fake.processCalls).toHaveLength(1);
		expect(fake.processCalls[0]?.args).toEqual([
			"--experimental-strip-types",
			"--no-warnings",
			"scripts/ci-runner-image-gc.mts",
			CANDIDATE,
		]);
		ensured(fake.events, "pull");
	});

	it("builds after a pull miss with memory and scheduling limits", async () => {
		const fake = harness();
		fake.setPullFails(true);
		const result = await createDepsImageEnsurer(fake.options).ensure();
		expect(result).toMatchObject({ status: "ensured", action: "build" });
		expect(fake.processCalls[0]).toMatchObject({
			command: "nice",
			args: [
				"-n",
				"10",
				"ionice",
				"-c",
				"2",
				"-n",
				"7",
				"bash",
				"packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh",
				"--no-promote",
			],
			env: { HOBO_CI_DEPS_BUILD_MEMORY_MB: "4096" },
		});
		expect(fake.processCalls[1]?.command).toBe(process.execPath);
		expect(fake.images.has("hobo-ci-deps:local")).toBe(true);
		ensured(fake.events, "build");
	});

	it("does nothing while the head and deps key are unchanged", async () => {
		const fake = harness();
		fake.images.add(CANDIDATE);
		const ensurer = createDepsImageEnsurer(fake.options);
		await ensurer.ensure();
		const calls = fake.options.docker.imageExists.mock.calls.length;
		expect(await ensurer.ensure()).toEqual({ status: "unchanged" });
		fake.setHead("b".repeat(40));
		expect(await ensurer.ensure()).toEqual({ status: "unchanged" });
		expect(fake.options.fs.depsKey).toHaveBeenCalledTimes(2);
		expect(fake.options.docker.imageExists).toHaveBeenCalledTimes(calls);
	});

	it("shares one background build across concurrent triggers", async () => {
		const fake = harness();
		fake.setPullFails(true);
		const gate = deferred();
		fake.setBuild(() => gate.promise);
		const ensurer = createDepsImageEnsurer(fake.options);
		const first = ensurer.ensure();
		const second = ensurer.ensure();
		await vi.waitFor(() => expect(fake.processCalls).toHaveLength(1));
		gate.release();
		expect(await first).toMatchObject({ status: "ensured", action: "build" });
		expect(await second).toMatchObject({ status: "ensured", action: "build" });
		expect(
			fake.processCalls.filter((call) => call.command === "nice"),
		).toHaveLength(1);
	});

	it("backs off a failed build without throwing, then retries", async () => {
		const fake = harness();
		fake.setPullFails(true);
		fake.setBuildFails(true);
		const ensurer = createDepsImageEnsurer(fake.options);
		expect(await ensurer.ensure()).toEqual({
			status: "failed",
			key: KEY,
			action: "build",
			ms: 0,
			message: "build failed",
			retryMs: 100,
		});
		expect(fake.events[0]).toEqual({
			event: "hobo_ci_deps_image_ensure_started",
			key: KEY,
		});
		expect(fake.events[1]).toMatchObject({
			event: "hobo_ci_deps_image_ensure_failed",
			retryMs: 100,
		});
		expect(await ensurer.ensure()).toEqual({ status: "backoff", retryMs: 100 });
		fake.setNow(1_100);
		fake.setBuildFails(false);
		expect(await ensurer.ensure()).toMatchObject({
			status: "ensured",
			action: "build",
		});
		expect(
			fake.processCalls.filter((call) => call.command === "nice"),
		).toHaveLength(2);
	});
});
