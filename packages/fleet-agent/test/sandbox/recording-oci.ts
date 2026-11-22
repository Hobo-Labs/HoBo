import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { ForwardRoute } from "../../src/sandbox/forwarder.js";
import {
	type OciConfig,
	type OciProcess,
	POD_CONTAINER_TYPE,
	POD_SANDBOX_ID,
} from "../../src/sandbox/oci-config.js";
import { STDIN_RELAY } from "../../src/sandbox/oci-driver.js";
import type { OciCalls } from "../../src/sandbox/oci-runtime.js";

export type RecordedContainer = {
	readonly id: string;
	readonly pid: number;
	readonly config: OciConfig;
	forwarder: OciConfig | undefined;
	routes: readonly ForwardRoute[];
	readonly files: Map<string, Uint8Array>;
	removed: boolean;
	forwarderStopped: boolean;
};

export type RecordingOci = OciCalls &
	Readonly<{
		calls: string[];
		processes: OciProcess[];
		containers: Map<string, RecordedContainer>;
	}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Answer = Readonly<{ status: number; body: string }>;

function send(
	socketPath: string,
	method: string,
	path: string,
	body: Uint8Array | undefined,
): Promise<Answer> {
	const headers = new Map([
		["host", new URL(path, "http://sandbox.invalid").host],
	]);
	if (body !== undefined) {
		headers.set("content-type", "application/json");
		headers.set("content-length", String(body.length));
	}
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath,
				method,
				path,
				headers: Object.fromEntries(headers),
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					text += chunk;
				});
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: text }),
				);
			},
		);
		req.on("error", reject);
		req.end(body === undefined ? undefined : Buffer.from(body));
	});
}

export function createRecordingOci(
	options: Readonly<{ versionFails?: boolean; startFails?: boolean }> = {},
): RecordingOci {
	const calls: string[] = [];
	const processes: OciProcess[] = [];
	const containers = new Map<string, RecordedContainer>();
	const pods = new Map<
		string,
		{
			config: OciConfig;
			routes: readonly ForwardRoute[];
			members: RecordedContainer[];
		}
	>();
	let pids = 1000;

	async function wget(
		container: RecordedContainer,
		process: OciProcess,
		stdin: Uint8Array | undefined,
		onOutput: (chunk: Uint8Array) => void,
	): Promise<number> {
		const url = new URL(process.args.at(-1) ?? "");
		const direct = process.args.includes("off");
		const posted = process.args.some((arg) => arg.startsWith("--post-file"));
		const proxy = process.env
			.find((entry) => entry.startsWith("http_proxy="))
			?.slice("http_proxy=".length);
		const port = Number(
			direct || proxy === undefined ? url.port : new URL(proxy).port,
		);
		const route = container.routes.find((entry) => entry.port === port);
		if (route === undefined) return 1;
		try {
			const answer = await send(
				route.socket,
				direct ? (posted ? "POST" : "GET") : "GET",
				direct ? `${url.pathname}${url.search}` : url.toString(),
				posted ? (stdin ?? new Uint8Array()) : undefined,
			);
			if (answer.status >= 200 && answer.status < 300) {
				onOutput(encoder.encode(answer.body));
				return 0;
			}
			return 1;
		} catch {
			return 1;
		}
	}

	return {
		calls,
		processes,
		containers,
		async version() {
			calls.push("version");
			if (options.versionFails === true)
				throw new Error("spawn runtime ENOENT");
			return "recording-oci 1.0";
		},
		async start(id, bundle) {
			calls.push(`start ${id}`);
			if (options.startFails === true) throw new Error("runtime run failed");
			pids += 1;
			const config: OciConfig = JSON.parse(
				readFileSync(join(bundle, "config.json"), "utf8"),
			);
			const container: RecordedContainer = {
				id,
				pid: pids,
				config,
				forwarder: undefined,
				routes: [],
				files: new Map(),
				removed: false,
				forwarderStopped: false,
			};
			const pod = pods.get(config.annotations[POD_SANDBOX_ID] ?? "");
			if (pod !== undefined) {
				container.forwarder = pod.config;
				container.routes = pod.routes;
				pod.members.push(container);
			}
			containers.set(id, container);
			return pids;
		},
		async forward(id, bundle) {
			calls.push(`forward ${id}`);
			const config: OciConfig = JSON.parse(
				readFileSync(join(bundle, "config.json"), "utf8"),
			);
			const routes: readonly ForwardRoute[] = JSON.parse(
				config.process.args[3] ?? "[]",
			);
			if (config.annotations[POD_CONTAINER_TYPE] === "sandbox") {
				const members: RecordedContainer[] = [];
				const pod = { config, routes, members };
				pods.set(id, pod);
				return {
					async stop() {
						for (const member of pod.members) member.forwarderStopped = true;
					},
				};
			}
			const netns = config.linux.namespaces.find(
				(entry) => entry.type === "network",
			)?.path;
			const container = [...containers.values()].find(
				(entry) => netns === `/proc/${entry.pid}/ns/net`,
			);
			if (container === undefined)
				throw new Error(`the forwarder ${id} names no running container`);
			container.forwarder = config;
			container.routes = routes;
			return {
				async stop() {
					container.forwarderStopped = true;
				},
			};
		},
		async exec(id, processFile, io) {
			calls.push(`exec ${id}`);
			const container = containers.get(id);
			if (container === undefined || container.removed)
				throw new Error(`container ${id} does not exist`);
			const recorded: OciProcess = JSON.parse(
				readFileSync(processFile, "utf8"),
			);
			processes.push(recorded);
			const relayed =
				recorded.args[2] === STDIN_RELAY && recorded.args[3] === "hobo-stdin";
			const process: OciProcess = relayed
				? { ...recorded, args: recorded.args.slice(4) }
				: recorded;
			const [program, flag, script, name, path] = process.args;
			if (program === "env") {
				io.onOutput(encoder.encode(`${process.env.join("\n")}\n`));
				return 0;
			}
			if (
				program === "sh" &&
				name === "hobo-write-secret" &&
				path !== undefined
			) {
				container.files.set(path, io.stdin ?? new Uint8Array());
				return 0;
			}
			if (
				program === "sh" &&
				flag === "-c" &&
				(script ?? "").includes("cmdline")
			) {
				io.onOutput(
					encoder.encode(
						processes.map((entry) => entry.args.join(" ")).join(" "),
					),
				);
				return 0;
			}
			if (program === "cat" && flag !== undefined) {
				const file = container.files.get(flag);
				if (file === undefined) return 1;
				io.onOutput(encoder.encode(decoder.decode(file)));
				return 0;
			}
			if (program === "wget")
				return wget(container, process, io.stdin, io.onOutput);
			return 0;
		},
		async remove(id) {
			calls.push(`remove ${id}`);
			const container = containers.get(id);
			if (container !== undefined) container.removed = true;
		},
	};
}
