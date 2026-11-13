/**
 * The OCI sandbox driver (design §6.11): `S1_CONTAINER` over `crun` or `runc`,
 * `S2_USER_KERNEL` over gVisor's `runsc`. One sandbox is one container made
 * from the order's image and the configuration of `oci-config.ts`, used for
 * one order and destroyed after it.
 *
 * Networking. The container's network namespace holds only loopback. The
 * driver serves two Unix sockets on the host, in a directory only the agent
 * can open: a relay to the order's egress proxy (`egressProxyUrl`, on the
 * host's loopback) and the control endpoint, an HTTP server answering
 * `POST /fence` from the order's `fence` callback. The relay hands a proxied
 * request for the sandbox's own `controlUrl` to the control endpoint, since
 * clients that honour `http_proxy` send it there. The forwarder
 * (`forwarder.ts`) listens on two loopback ports inside the namespace and
 * pipes them to those sockets. Inside the sandbox `http_proxy` and
 * `https_proxy` name the first port, and `controlUrl` is
 * `http://127.0.0.1:<second port>`; ports are distinct across this agent's
 * live sandboxes, so no sandbox has a listener on another's control port.
 *
 * Self-test (`available`): the runtime answers its version, then a trial
 * sandbox over the host's own read-only `/usr` (no image pull) starts with
 * the full configuration (user namespace, cgroup limits, seccomp, network
 * namespace, forwarder), runs `true`, and is destroyed. A runtime that cannot
 * apply any part of it fails the self-test and is not advertised.
 */
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import type {
	FleetLog,
	ObservedAssignment,
	Outcome,
	Sandbox,
	SandboxDriver,
	SandboxTier,
} from "@hobo/fleet";
import { SandboxTier as Tier } from "@hobo/fleet";
import type { ImageStore } from "./image.js";
import { parseObservedAssignment } from "./observed.js";
import {
	DOCKER_SOCKET,
	ociConfig,
	ROOTFUL_ID_BASE,
	type SandboxLimits,
	sandboxProcess,
} from "./oci-config.js";
import type { ExecIo, OciCalls } from "./oci-runtime.js";

export type OciDriverOptions = Readonly<{
	tier: SandboxTier;
	/** The runtime's name, for log lines (`crun`, `runc`, `runsc`). */
	runtime: string;
	calls: OciCalls;
	images: ImageStore;
	/** Directory for bundles and sockets (0711; each sandbox's own directory is 0700). */
	workRoot: string;
	/** The agent's uid and gid when it is not root; undefined when it is. */
	rootless: Readonly<{ uid: number; gid: number }> | undefined;
	log: FleetLog;
}>;

const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PROXY_VARIABLES = [
	"http_proxy",
	"https_proxy",
	"HTTP_PROXY",
	"HTTPS_PROXY",
];
const INIT_ARGS: readonly string[] = ["sleep", "2147483647"];
const FENCE_BODY_LIMIT = 64 * 1024;
const SECRET_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
/** Host directories the self-test's trial sandbox mounts read-only in place of an image. */
const TRIAL_HOST_DIRS: readonly string[] = [
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
];
const TRIAL_LIMITS: SandboxLimits = {
	memoryMb: 64,
	cpus: 0.5,
	pids: 32,
	diskMb: 16,
};

/** Loopback ports held by this agent's live sandboxes, across drivers. */
const portsInUse = new Set<number>();

function allocatePort(): number {
	for (;;) {
		const port = 20_000 + (randomBytes(2).readUInt16BE(0) % 40_000);
		if (!portsInUse.has(port)) {
			portsInUse.add(port);
			return port;
		}
	}
}

function listen(
	server: Server | ReturnType<typeof createNetServer>,
	path: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(
	server: Server | ReturnType<typeof createNetServer>,
): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** The HTTP control endpoint of one sandbox: `POST /fence` answers from `fence`. */
function controlServer(
	fence: (observed: ObservedAssignment) => Promise<boolean>,
): Server {
	const server = createHttpServer((req, res) => {
		// busybox wget sends its --post-file body with GET when it goes through a
		// proxy, so a GET carrying a body counts as the POST it meant.
		const posted =
			req.method === "POST" ||
			(req.method === "GET" && Number(req.headers["content-length"] ?? 0) > 0);
		if (!posted || (req.url ?? "").split("?")[0] !== "/fence") {
			res.writeHead(404, { connection: "close" }).end();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size <= FENCE_BODY_LIMIT) chunks.push(chunk);
		});
		req.on("end", () => {
			const observed =
				size > FENCE_BODY_LIMIT
					? undefined
					: parseObservedAssignment(Buffer.concat(chunks).toString("utf8"));
			const answer = (allow: boolean) =>
				res
					.writeHead(200, {
						"content-type": "application/json",
						connection: "close",
					})
					.end(JSON.stringify({ allow }));
			if (observed === undefined) {
				answer(false);
				return;
			}
			fence(observed).then(
				(allow) => answer(allow === true),
				() => answer(false),
			);
		});
	});
	// busybox wget shuts down its write side after the request.
	Object.assign(server, { httpAllowHalfOpen: true });
	return server;
}

/** The longest request line the relay reads before choosing where a connection goes. */
const REQUEST_LINE_LIMIT = 8 * 1024;

/**
 * The relay behind a sandbox's proxy port. Every connection goes to the
 * order's egress proxy on the host's loopback, except a request whose
 * absolute-form target is this sandbox's own `controlUrl`: proxy-aware clients
 * (busybox wget ignores `no_proxy`) send those to the proxy port too, so the
 * relay rewrites the request line to origin form and pipes the connection to
 * the control endpoint. Another sandbox's `controlUrl` is not matched and
 * reaches the egress proxy, which refuses loopback.
 */
function sandboxRelay(
	egressProxyUrl: string,
	controlPort: number,
	controlSocket: string,
) {
	const target = new URL(egressProxyUrl);
	const port = Number(target.port === "" ? 80 : target.port);
	const host = target.hostname.replace(/^\[|\]$/gu, "");
	const own = new RegExp(
		`^([A-Z]+) http://(?:127\\.0\\.0\\.1|localhost):${controlPort}(/[^ ]*) (HTTP/1\\.[01])\r\n`,
		"u",
	);
	return createNetServer({ allowHalfOpen: true }, (client) => {
		let head = Buffer.alloc(0);
		client.on("error", () => client.destroy());
		const choose = (chunk: Buffer) => {
			head = Buffer.concat([head, chunk]);
			const end = head.indexOf("\r\n");
			if (end < 0 && head.length < REQUEST_LINE_LIMIT) return;
			client.off("data", choose);
			client.pause();
			const match = own.exec(head.subarray(0, end + 2).toString("latin1"));
			const upstream =
				match === null ? connect({ host, port }) : connect(controlSocket);
			const first =
				match === null
					? head
					: Buffer.concat([
							Buffer.from(`${match[1]} ${match[2]} ${match[3]}\r\n`, "latin1"),
							head.subarray(end + 2),
						]);
			upstream.on("error", () => client.destroy());
			client.once("close", () => upstream.destroy());
			upstream.write(first);
			upstream.pipe(client);
			client.pipe(upstream);
			client.resume();
		};
		client.on("data", choose);
	});
}

/** The self-test's root file system and the host directories it binds. */
type TrialRoot = Readonly<{
	rootfs: string;
	mounts: readonly Readonly<{ source: string; target: string }>[];
}>;

type Launch = Readonly<{
	rootfs: string;
	limits: SandboxLimits;
	readOnlyMounts: readonly Readonly<{ source: string; target: string }>[];
	hostDocker: boolean;
	egressProxyUrl: string;
	fence: (observed: ObservedAssignment) => Promise<boolean>;
}>;

export function createOciSandboxDriver(
	options: OciDriverOptions,
): SandboxDriver {
	const orders = new Set<string>();

	function prepareRoot(): void {
		// 0711: the self-test's trial root file system lives here and a remapped root must reach it;
		// each sandbox's own directory (bundle, sockets) is 0700.
		mkdirSync(options.workRoot, { recursive: true, mode: 0o711 });
		chmodSync(options.workRoot, 0o711);
	}

	async function launch(input: Launch): Promise<Sandbox> {
		prepareRoot();
		const id = `hobo-${randomBytes(10).toString("hex")}`;
		const dir = join(options.workRoot, id);
		mkdirSync(dir, { mode: 0o700 });
		const controlSocket = join(dir, "control.sock");
		const egressSocket = join(dir, "egress.sock");
		const proxyPort = allocatePort();
		const controlPort = allocatePort();
		const control = controlServer(input.fence);
		const relay = sandboxRelay(
			input.egressProxyUrl,
			controlPort,
			controlSocket,
		);
		const proxyUrl = `http://127.0.0.1:${proxyPort}`;
		const baseEnv = {
			PATH,
			HOME: "/work",
			...Object.fromEntries(PROXY_VARIABLES.map((name) => [name, proxyUrl])),
			no_proxy: "",
			NO_PROXY: "",
		} satisfies Readonly<Record<string, string>>;
		let forwarder: Readonly<{ stop(): void }> | undefined;
		let started = false;
		let execs = 0;
		let destroyed: Promise<void> | undefined;

		const destroy = (): Promise<void> => {
			destroyed ??= (async () => {
				forwarder?.stop();
				try {
					if (started) await options.calls.remove(id);
				} finally {
					await Promise.all([closeServer(control), closeServer(relay)]);
					rmSync(dir, { recursive: true, force: true });
					portsInUse.delete(proxyPort);
					portsInUse.delete(controlPort);
				}
			})();
			return destroyed;
		};

		try {
			await listen(control, controlSocket);
			await listen(relay, egressSocket);
			const config = ociConfig({
				id,
				rootfs: input.rootfs,
				limits: input.limits,
				readOnlyMounts: input.readOnlyMounts,
				hostDocker: input.hostDocker,
				rootless: options.rootless,
				args: INIT_ARGS,
				env: [`PATH=${PATH}`],
			});
			writeFileSync(join(dir, "config.json"), JSON.stringify(config), {
				mode: 0o600,
			});
			started = true;
			const pid = await options.calls.start(id, dir);
			forwarder = await options.calls.forward(pid, [
				{ port: proxyPort, socket: egressSocket },
				{ port: controlPort, socket: controlSocket },
			]);
		} catch (error) {
			await destroy().catch(() => undefined);
			throw error;
		}

		const usable = () => {
			if (destroyed !== undefined)
				throw new Error(`sandbox ${id} is destroyed`);
		};

		const sandbox: Sandbox = {
			id,
			tier: options.tier,
			controlUrl: `http://127.0.0.1:${controlPort}`,
			async exec(command) {
				usable();
				if (command.signal.aborted) return { exitCode: 130 };
				execs += 1;
				const processFile = join(dir, `exec-${execs}.json`);
				// The proxy variables always name this sandbox's forwarder.
				const env = new Map(Object.entries({ ...baseEnv, ...command.env }));
				for (const name of PROXY_VARIABLES) env.set(name, proxyUrl);
				writeFileSync(
					processFile,
					JSON.stringify(
						sandboxProcess(
							command.argv,
							[...env].map(([name, value]) => `${name}=${value}`),
							"/work",
						),
					),
					{ mode: 0o600 },
				);
				try {
					const io: ExecIo =
						command.stdin === undefined
							? { signal: command.signal, onOutput: command.onOutput }
							: {
									stdin: command.stdin,
									signal: command.signal,
									onOutput: command.onOutput,
								};
					const exitCode = await options.calls.exec(id, processFile, io);
					return { exitCode };
				} finally {
					rmSync(processFile, { force: true });
				}
			},
			async writeSecret(path, bytes) {
				usable();
				if (!SECRET_PATH.test(path) || path.split("/").includes(".."))
					throw new Error(`not a plain absolute path: ${path}`);
				const output: Uint8Array[] = [];
				const { exitCode } = await sandbox.exec({
					argv: [
						"sh",
						"-c",
						'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1"',
						"hobo-write-secret",
						path,
					],
					env: {},
					stdin: bytes,
					signal: new AbortController().signal,
					onOutput(chunk) {
						output.push(chunk);
					},
				});
				if (exitCode !== 0)
					throw new Error(
						`writing ${path} in sandbox ${id} failed (exit ${exitCode}): ${Buffer.concat(output).toString("utf8").slice(0, 200)}`,
					);
			},
			destroy,
		};
		return sandbox;
	}

	/** A root file system of empty mount points, binding the host's own read-only system directories. */
	function trialRootfs(): TrialRoot {
		prepareRoot();
		const rootfs = join(
			options.workRoot,
			`trial-${randomBytes(6).toString("hex")}`,
		);
		const mounts: { source: string; target: string }[] = [];
		mkdirSync(rootfs, { mode: 0o755 });
		for (const dir of ["proc", "dev", "sys", "tmp", "run", "work"])
			mkdirSync(join(rootfs, dir));
		for (const hostDir of TRIAL_HOST_DIRS) {
			if (!existsSync(hostDir)) continue;
			const stat = lstatSync(hostDir);
			const target = join(rootfs, hostDir);
			if (stat.isSymbolicLink()) symlinkSync(readlinkSync(hostDir), target);
			else if (stat.isDirectory()) {
				mkdirSync(target);
				mounts.push({ source: hostDir, target: hostDir });
			}
		}
		if (options.rootless === undefined)
			chownSync(rootfs, ROOTFUL_ID_BASE, ROOTFUL_ID_BASE);
		return { rootfs, mounts };
	}

	async function selfTest(): Promise<
		Outcome<Readonly<{ providesDocker: boolean }>>
	> {
		const unavailable = (message: string) => {
			options.log("hobo_fleet_sandbox_unavailable", {
				tier: Tier[options.tier] ?? String(options.tier),
				runtime: options.runtime,
				reason: message.slice(0, 300),
			});
			return {
				ok: false as const,
				error: { code: "sandbox-inadequate" as const, message },
			};
		};
		try {
			await options.calls.version();
		} catch (error) {
			return unavailable(`${options.runtime} is not usable: ${String(error)}`);
		}
		let trial: TrialRoot | undefined;
		try {
			trial = trialRootfs();
			const sandbox = await launch({
				rootfs: trial.rootfs,
				limits: TRIAL_LIMITS,
				readOnlyMounts: trial.mounts,
				hostDocker: false,
				egressProxyUrl: "http://127.0.0.1:9",
				fence: async () => false,
			});
			try {
				const { exitCode } = await sandbox.exec({
					argv: ["true"],
					env: {},
					signal: AbortSignal.timeout(30_000),
					onOutput() {},
				});
				if (exitCode !== 0)
					return unavailable(
						`the trial sandbox ran true with exit ${exitCode}`,
					);
			} finally {
				await sandbox.destroy();
			}
		} catch (error) {
			return unavailable(`the trial sandbox failed: ${String(error)}`);
		} finally {
			if (trial !== undefined)
				rmSync(trial.rootfs, { recursive: true, force: true });
		}
		return { ok: true, value: { providesDocker: false } };
	}

	let available: ReturnType<typeof selfTest> | undefined;

	return {
		tier: options.tier,
		available() {
			available ??= selfTest();
			return available;
		},
		async create(input) {
			if (orders.has(input.orderId))
				throw new Error(
					`a sandbox was already created for order ${input.orderId}`,
				);
			orders.add(input.orderId);
			const { memoryMb, cpus, pids, diskMb } = input.limits;
			if (!(memoryMb > 0 && cpus > 0 && pids > 0 && diskMb > 0))
				throw new Error("sandbox limits must be positive");
			if (input.hostDocker && !existsSync(DOCKER_SOCKET))
				throw new Error(
					`hostDocker asked for, but ${DOCKER_SOCKET} does not exist`,
				);
			const rootfs = await options.images.rootfs(input.image);
			return launch({
				rootfs,
				limits: input.limits,
				readOnlyMounts: input.readOnlyMounts,
				hostDocker: input.hostDocker,
				egressProxyUrl: input.egressProxyUrl,
				fence: input.fence,
			});
		},
	};
}
