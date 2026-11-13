/**
 * The sandbox drivers' logic (L38 isolated checks): `runSandboxConformance`
 * for each OCI driver with its runtime calls replaced by a recording double,
 * the driver's own guarantees on top of it, and the selection that
 * `sandboxDrivers` makes.
 */
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { type AddressInfo, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FleetLog,
	type ObservedAssignment,
	type SandboxDriver,
	SandboxTier,
	WorkOrigin,
} from "@hobo/fleet";
import {
	createFakeSandboxDriver,
	runSandboxConformance,
} from "@hobo/fleet/testing";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { selectSandboxDrivers } from "../../src/sandbox/index.js";
import {
	APPLE_CONTAINER_RUNTIME,
	createMicroVmSandboxDriver,
	KATA_RUNTIME,
} from "../../src/sandbox/microvm.js";
import {
	forwarderUid,
	hostPidsBackstop,
	POD_CONTAINER_TYPE,
	POD_SANDBOX_ID,
} from "../../src/sandbox/oci-config.js";
import {
	createOciSandboxDriver,
	createOciSandboxDrivers,
	STDIN_RELAY,
} from "../../src/sandbox/oci-driver.js";
import { createRecordingOci, type RecordingOci } from "./recording-oci.js";

const root = mkdtempSync(join(tmpdir(), "hobo-l38-drivers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const logged: string[] = [];
const log: FleetLog = (event, fields) => {
	logged.push(`${event} ${JSON.stringify(fields)}`);
};

const images = {
	async rootfs(image: string) {
		const dir = join(root, "images", image.replace(/[^a-z0-9]/giu, "_"));
		mkdirSync(dir, { recursive: true });
		return dir;
	},
};

function driver(
	tier: SandboxTier,
	oci: RecordingOci = createRecordingOci(),
): SandboxDriver {
	return createOciSandboxDriver({
		tier,
		runtime: "recording",
		flavor: "runsc",
		cgroups: { mode: "sentry" },
		calls: oci,
		images,
		workRoot: mkdtempSync(join(root, "work-")),
		rootless: { uid: 1000, gid: 1000 },
		log,
	});
}

describe("S1_CONTAINER OCI driver over the recording double", () => {
	runSandboxConformance(() => driver(SandboxTier.S1_CONTAINER));
});

describe("S2_USER_KERNEL OCI driver over the recording double", () => {
	runSandboxConformance(() => driver(SandboxTier.S2_USER_KERNEL));
});

const observed: ObservedAssignment = {
	workKey: "work#1",
	repository: "hobo/repo",
	ref: "refs/heads/main",
	author: "octocat",
	origin: WorkOrigin.INTERNAL,
};

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0))
		await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A stand-in egress proxy that records each request line and refuses it with 403. */
async function refusingProxy(lines: string[]): Promise<string> {
	const server = createServer((socket) => {
		socket.once("data", (chunk) => {
			lines.push(String(chunk).split("\r\n")[0] ?? "");
			socket.end(
				"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
			);
		});
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	// SAFETY: a TCP server listening on a port answers an AddressInfo.
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

async function run(
	sandbox: Awaited<ReturnType<SandboxDriver["create"]>>,
	argv: readonly string[],
	options: Readonly<{
		env?: Readonly<Record<string, string>>;
		stdin?: string;
	}> = {},
): Promise<Readonly<{ exitCode: number; output: string }>> {
	let output = "";
	const command = {
		argv,
		env: options.env ?? {},
		signal: new AbortController().signal,
		onOutput(chunk: Uint8Array) {
			output += new TextDecoder().decode(chunk);
		},
	};
	const { exitCode } = await sandbox.exec(
		options.stdin === undefined
			? command
			: { ...command, stdin: new TextEncoder().encode(options.stdin) },
	);
	return { exitCode, output };
}

function createInput(
	orderId: string,
	egressProxyUrl: string,
	fence: (facts: ObservedAssignment) => Promise<boolean>,
) {
	return {
		orderId,
		image: "docker.io/library/busybox:1.37",
		limits: { memoryMb: 128, cpus: 1, pids: 32, diskMb: 64 },
		egressProxyUrl,
		readOnlyMounts: [{ source: "/srv/cache", target: "/cache" }],
		hostDocker: false,
		fence,
	};
}

describe("createOciSandboxDriver", () => {
	it("starts a container from the S1 configuration and forwards only the proxy and control ports", async () => {
		const oci = createRecordingOci();
		const sandbox = await driver(SandboxTier.S1_CONTAINER, oci).create(
			createInput("order-config", "http://127.0.0.1:9", async () => true),
		);
		try {
			const container = oci.containers.get(sandbox.id);
			expect(container).toBeDefined();
			const config = container?.config;
			expect(config?.process.capabilities.effective).toEqual([]);
			expect(config?.process.capabilities.bounding).toEqual([]);
			expect(config?.process.noNewPrivileges).toBe(true);
			expect(config?.root.readonly).toBe(true);
			// runsc: the pids limit holds in the sentry; the host cgroup only backstops it.
			expect(config?.process.rlimits).toContainEqual({
				type: "RLIMIT_NPROC",
				hard: 32,
				soft: 32,
			});
			expect(config?.linux.resources.pids.limit).toBe(hostPidsBackstop(32));
			expect(config?.linux.resources.memory.limit).toBe(128 * 1024 * 1024);
			expect(config?.linux.namespaces.map((entry) => entry.type)).toContain(
				"network",
			);
			expect(config?.linux.uidMappings).toEqual([
				{ containerID: 0, hostID: 1000, size: 1 },
			]);
			const binds =
				config?.mounts.filter((mount) => mount.type === "bind") ?? [];
			expect(binds.map((mount) => [mount.source, mount.destination])).toEqual([
				["/srv/cache", "/cache"],
			]);
			expect(container?.routes).toHaveLength(2);
			expect(sandbox.controlUrl).toBe(
				`http://127.0.0.1:${container?.routes[1]?.port}`,
			);
		} finally {
			await sandbox.destroy();
		}
	});

	it("names its own forwarder in every proxy variable, whatever the caller passes", async () => {
		const oci = createRecordingOci();
		const sandbox = await driver(SandboxTier.S1_CONTAINER, oci).create(
			createInput("order-env", "http://127.0.0.1:9", async () => true),
		);
		try {
			const { output } = await run(sandbox, ["env"], {
				env: { http_proxy: "http://evil.example:1", FOO: "bar" },
			});
			const proxyPort = oci.containers.get(sandbox.id)?.routes[0]?.port;
			for (const name of [
				"http_proxy",
				"https_proxy",
				"HTTP_PROXY",
				"HTTPS_PROXY",
			])
				expect(output).toContain(`${name}=http://127.0.0.1:${proxyPort}\n`);
			expect(output).toContain("FOO=bar\n");
			expect(output).not.toContain("evil.example");
		} finally {
			await sandbox.destroy();
		}
	});

	it("answers a proxied request for its own controlUrl from the fence, and sends other traffic to the egress proxy", async () => {
		const lines: string[] = [];
		const egress = await refusingProxy(lines);
		const asked: ObservedAssignment[] = [];
		const make = driver(SandboxTier.S1_CONTAINER);
		const first = await make.create(
			createInput("order-relay-1", egress, async (facts) => {
				asked.push(facts);
				return true;
			}),
		);
		const second = await make.create(
			createInput("order-relay-2", egress, async () => true),
		);
		const fence = (url: string) => [
			"wget",
			"-q",
			"-O-",
			"--post-file=/dev/stdin",
			`${url}/fence`,
		];
		try {
			const own = await run(first, fence(first.controlUrl), {
				stdin: JSON.stringify(observed),
			});
			expect(own).toEqual({ exitCode: 0, output: '{"allow":true}' });
			expect(asked).toEqual([observed]);

			const other = await run(second, fence(first.controlUrl), {
				stdin: JSON.stringify(observed),
			});
			expect(other.exitCode).not.toBe(0);
			expect(other.output).not.toContain("allow");
			expect(asked).toHaveLength(1);
			expect(lines).toEqual([`GET ${first.controlUrl}/fence HTTP/1.1`]);

			const outside = await run(first, [
				"wget",
				"-q",
				"-O-",
				"http://example.test/x",
			]);
			expect(outside.exitCode).toBe(1);
			expect(lines.at(-1)).toBe("GET http://example.test/x HTTP/1.1");

			const unreadable = await run(first, fence(first.controlUrl), {
				stdin: "{",
			});
			expect(unreadable.output).toBe('{"allow":false}');
			expect(asked).toHaveLength(1);
		} finally {
			await first.destroy();
			await second.destroy();
		}
	});

	it("answers false when the fence callback throws", async () => {
		const sandbox = await driver(SandboxTier.S1_CONTAINER).create(
			createInput("order-throw", "http://127.0.0.1:9", async () => {
				throw new Error("fence broke");
			}),
		);
		try {
			const answer = await run(
				sandbox,
				[
					"wget",
					"-q",
					"-O-",
					"-Y",
					"off",
					"--post-file=/dev/stdin",
					`${sandbox.controlUrl}/fence`,
				],
				{ stdin: JSON.stringify(observed) },
			);
			expect(answer.output).toBe('{"allow":false}');
		} finally {
			await sandbox.destroy();
		}
	});

	it("writes a secret only through standard input, to a plain absolute path", async () => {
		const oci = createRecordingOci();
		const sandbox = await driver(SandboxTier.S1_CONTAINER, oci).create(
			createInput("order-secret", "http://127.0.0.1:9", async () => true),
		);
		try {
			await sandbox.writeSecret(
				"/run/hobo/registration",
				new TextEncoder().encode("token-123"),
			);
			expect(
				new TextDecoder().decode(
					oci.containers.get(sandbox.id)?.files.get("/run/hobo/registration"),
				),
			).toBe("token-123");
			for (const process of oci.processes) {
				expect(process.args.join(" ")).not.toContain("token-123");
				expect(process.env.join(" ")).not.toContain("token-123");
			}
			await expect(
				sandbox.writeSecret("/run/../etc/passwd", new Uint8Array()),
			).rejects.toThrow(/plain absolute path/u);
			await expect(
				sandbox.writeSecret("relative", new Uint8Array()),
			).rejects.toThrow();
		} finally {
			await sandbox.destroy();
		}
	});

	it("removes the container, stops the forwarder and deletes its directory on destroy", async () => {
		const oci = createRecordingOci();
		const workRoot = mkdtempSync(join(root, "work-"));
		const make = createOciSandboxDriver({
			tier: SandboxTier.S1_CONTAINER,
			runtime: "recording",
			flavor: "runsc",
			cgroups: { mode: "sentry" },
			calls: oci,
			images,
			workRoot,
			rootless: { uid: 1000, gid: 1000 },
			log,
		});
		const sandbox = await make.create(
			createInput("order-destroy", "http://127.0.0.1:9", async () => true),
		);
		expect(readdirSync(workRoot)).toEqual([sandbox.id]);
		await sandbox.destroy();
		const container = oci.containers.get(sandbox.id);
		expect(container?.removed).toBe(true);
		expect(container?.forwarderStopped).toBe(true);
		expect(readdirSync(workRoot)).toEqual([]);
	});

	it("cleans up when the runtime cannot start the container", async () => {
		const workRoot = mkdtempSync(join(root, "work-"));
		const make = createOciSandboxDriver({
			tier: SandboxTier.S1_CONTAINER,
			runtime: "recording",
			flavor: "runsc",
			cgroups: { mode: "sentry" },
			calls: createRecordingOci({ startFails: true }),
			images,
			workRoot,
			rootless: { uid: 1000, gid: 1000 },
			log,
		});
		await expect(
			make.create(
				createInput("order-fail", "http://127.0.0.1:9", async () => true),
			),
		).rejects.toThrow(/runtime run failed/u);
		expect(readdirSync(workRoot)).toEqual([]);
	});

	it("refuses limits that are not positive", async () => {
		const make = driver(SandboxTier.S1_CONTAINER);
		await expect(
			make.create({
				...createInput("order-limits", "http://127.0.0.1:9", async () => true),
				limits: { memoryMb: 0, cpus: 1, pids: 32, diskMb: 64 },
			}),
		).rejects.toThrow(/positive/u);
	});

	it("passes its self-test over a working runtime and fails it, logging why, over a missing one", async () => {
		const working = createRecordingOci();
		expect(await driver(SandboxTier.S1_CONTAINER, working).available()).toEqual(
			{
				ok: true,
				value: { providesDocker: false },
			},
		);
		expect(
			working.calls.filter((call) => call.startsWith("start")),
		).toHaveLength(1);
		expect(
			working.calls.filter((call) => call.startsWith("remove")),
		).toHaveLength(1);

		logged.length = 0;
		const missing = await driver(
			SandboxTier.S1_CONTAINER,
			createRecordingOci({ versionFails: true }),
		).available();
		expect(missing.ok).toBe(false);
		expect(logged.join("\n")).toMatch(
			/hobo_fleet_sandbox_unavailable.*not usable/u,
		);

		const broken = await driver(
			SandboxTier.S1_CONTAINER,
			createRecordingOci({ startFails: true }),
		).available();
		expect(broken.ok).toBe(false);
	});
});

describe("the forwarder container (D58)", () => {
	it("under runsc, starts the forwarder as the pod and the workload in it, with the sentry's limits on every process", async () => {
		const oci = createRecordingOci();
		const sandbox = await driver(SandboxTier.S2_USER_KERNEL, oci).create(
			createInput("order-pod", "http://127.0.0.1:9", async () => true),
		);
		try {
			const container = oci.containers.get(sandbox.id);
			const pod = `hobofwd-${sandbox.id.slice("hobo-".length)}`;
			expect(container?.config.annotations).toEqual({
				[POD_CONTAINER_TYPE]: "container",
				[POD_SANDBOX_ID]: pod,
			});
			expect(container?.forwarder?.annotations).toEqual({
				[POD_CONTAINER_TYPE]: "sandbox",
				[POD_SANDBOX_ID]: pod,
			});
			// Rootless: the agent's id, in a pid namespace above the workload's.
			expect(container?.forwarder?.process.user.uid).toBe(
				forwarderUid({ uid: 1000, gid: 1000 }),
			);
			expect(container?.forwarder?.root).toEqual({
				path: "/",
				readonly: true,
			});
			expect(oci.calls.filter((call) => !call.startsWith("exec"))).toEqual([
				`forward ${pod}`,
				`start ${sandbox.id}`,
			]);
			await run(sandbox, ["true"]);
			const exec = oci.processes.at(-1);
			expect(exec?.rlimits).toContainEqual({
				type: "RLIMIT_NPROC",
				hard: 32,
				soft: 32,
			});
			expect(exec?.rlimits).toContainEqual({
				type: "RLIMIT_AS",
				hard: 128 * 1024 * 1024,
				soft: 128 * 1024 * 1024,
			});
		} finally {
			await sandbox.destroy();
		}
	});

	it("under runsc, relays standard input through a pipe inside the sandbox, so /dev/stdin opens", async () => {
		const oci = createRecordingOci();
		const sandbox = await driver(SandboxTier.S1_CONTAINER, oci).create(
			createInput("order-stdin", "http://127.0.0.1:9", async () => true),
		);
		try {
			const argv = [
				"wget",
				"-q",
				"-O-",
				"-Y",
				"off",
				"--post-file=/dev/stdin",
				`${sandbox.controlUrl}/fence`,
			];
			const answer = await run(sandbox, argv, {
				stdin: JSON.stringify(observed),
			});
			expect(answer).toEqual({ exitCode: 0, output: '{"allow":true}' });
			expect(oci.processes.at(-1)?.args).toEqual([
				"sh",
				"-c",
				STDIN_RELAY,
				"hobo-stdin",
				...argv,
			]);
			await run(sandbox, ["true"]);
			expect(oci.processes.at(-1)?.args).toEqual(["true"]);
		} finally {
			await sandbox.destroy();
		}
	});

	it("under a host runtime, joins the workload's network namespace by path", async () => {
		const oci = createRecordingOci();
		const make = createOciSandboxDriver({
			tier: SandboxTier.S1_CONTAINER,
			runtime: "recording",
			flavor: "oci",
			cgroups: { mode: "delegated", parent: "/hobo-fleet" },
			calls: oci,
			images,
			workRoot: mkdtempSync(join(root, "work-")),
			rootless: { uid: 1000, gid: 1000 },
			log,
		});
		const sandbox = await make.create(
			createInput("order-netns", "http://127.0.0.1:9", async () => true),
		);
		try {
			const container = oci.containers.get(sandbox.id);
			expect(container?.forwarder?.linux.namespaces).toContainEqual({
				type: "network",
				path: `/proc/${container?.pid}/ns/net`,
			});
			expect(container?.config.annotations).toEqual({});
			expect(container?.routes).toHaveLength(2);
		} finally {
			await sandbox.destroy();
		}
	});
});

describe("createOciSandboxDrivers", () => {
	it("serves S1 and S2 over one runtime with one self-test, and an order id once across them", async () => {
		const oci = createRecordingOci();
		const [s1, s2] = createOciSandboxDrivers({
			tiers: [SandboxTier.S1_CONTAINER, SandboxTier.S2_USER_KERNEL],
			runtime: "recording",
			flavor: "runsc",
			cgroups: { mode: "sentry" },
			calls: oci,
			images,
			workRoot: mkdtempSync(join(root, "work-")),
			rootless: { uid: 1000, gid: 1000 },
			log,
		});
		expect(s1?.tier).toBe(SandboxTier.S1_CONTAINER);
		expect(s2?.tier).toBe(SandboxTier.S2_USER_KERNEL);
		expect((await s1?.available())?.ok).toBe(true);
		expect((await s2?.available())?.ok).toBe(true);
		expect(oci.calls.filter((call) => call.startsWith("start"))).toHaveLength(
			1,
		);
		const sandbox = await s2?.create(
			createInput("order-shared", "http://127.0.0.1:9", async () => true),
		);
		expect(sandbox?.tier).toBe(SandboxTier.S2_USER_KERNEL);
		await sandbox?.destroy();
		await expect(
			s1?.create(
				createInput("order-shared", "http://127.0.0.1:9", async () => true),
			),
		).rejects.toThrow(/already created/u);
	});
});

describe("S3 microVM drivers", () => {
	it.each([
		["[A11] Kata", KATA_RUNTIME],
		["[A12] Apple container", APPLE_CONTAINER_RUNTIME],
	])("%s fails its self-test closed and creates nothing", async (_name, runtime) => {
		const made = createMicroVmSandboxDriver(runtime, log);
		expect(made.tier).toBe(SandboxTier.S3_MICROVM);
		const answer = await made.available();
		expect(answer.ok).toBe(false);
		expect(answer.ok ? "" : answer.error.message).toContain(
			`${runtime.assumption} not tested; fallback taken`,
		);
		await expect(
			made.create(
				createInput("order-vm", "http://127.0.0.1:9", async () => true),
			),
		).rejects.toThrow();
	});
});

describe("selectSandboxDrivers", () => {
	const failing = (tier: SandboxTier): SandboxDriver => ({
		...createFakeSandboxDriver(tier),
		async available() {
			return {
				ok: false,
				error: { code: "sandbox-inadequate", message: "no" },
			};
		},
	});

	it("keeps the first passing candidate of each tier, ordered by tier", async () => {
		const s1a = failing(SandboxTier.S1_CONTAINER);
		const s1b = createFakeSandboxDriver(SandboxTier.S1_CONTAINER);
		const s1c = createFakeSandboxDriver(SandboxTier.S1_CONTAINER);
		const s3 = createFakeSandboxDriver(SandboxTier.S3_MICROVM);
		const s2 = createFakeSandboxDriver(SandboxTier.S2_USER_KERNEL);
		const chosen = await selectSandboxDrivers(
			[s1a, s1b, s1c, s3, s2],
			undefined,
		);
		expect(chosen).toEqual([s1b, s2, s3]);
	});

	it("leaves out tiers above the cap, and everything under an unspecified cap", async () => {
		const s1 = createFakeSandboxDriver(SandboxTier.S1_CONTAINER);
		const s2 = createFakeSandboxDriver(SandboxTier.S2_USER_KERNEL);
		const s3 = createFakeSandboxDriver(SandboxTier.S3_MICROVM);
		expect(
			await selectSandboxDrivers([s3, s2, s1], SandboxTier.S2_USER_KERNEL),
		).toEqual([s1, s2]);
		expect(await selectSandboxDrivers([s1], SandboxTier.UNSPECIFIED)).toEqual(
			[],
		);
	});

	it("answers no driver when every self-test fails", async () => {
		expect(
			await selectSandboxDrivers(
				[
					failing(SandboxTier.S1_CONTAINER),
					failing(SandboxTier.S2_USER_KERNEL),
				],
				undefined,
			),
		).toEqual([]);
	});
});
