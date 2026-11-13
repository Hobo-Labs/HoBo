/**
 * `hobo serve control` — local control-plane HTTP+SSE for the Yard game UI.
 * Same management surface as CLI/MCP (ADR-0150 / ADR-0111 spirit).
 *
 * `hobo serve cd` — the CD conductor service (plan 0024): tick loop,
 * conductor reconciler, `/v1/cd/` read API + agent delivery feed, health and
 * readiness. `--simulate` is its only fixture path and is labelled.
 */

import type { CommandModule, CommandResult } from "@hobo/cli";
import { createControlApiServer } from "@hobo/control-api";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { cdFlagsOf } from "./cd-render.js";
import { topologyFilesOf } from "./cd-topology.js";
import { isJsonNumber, isJsonString, type JsonObject } from "./json.js";

export interface ServeControlCommandDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly hoboHome?: string;
	readonly port?: number;
	readonly host?: string;
	/** When true, return immediately after bind (tests). */
	readonly once?: boolean;
	/** Demo mode: feed the world read model from the yard-world simulator (`--demo` / HOBO_CONTROL_DEMO=1). */
	readonly demo?: boolean;
	/** Deterministic simulator seed (`--demo-seed` / HOBO_CONTROL_DEMO_SEED). */
	readonly demoSeed?: number;
	readonly log?: (line: string) => void;
	/** `hobo serve cd`: start the CD service (tests inject; default opens cd-runtime + cd-serve). */
	readonly serveCd?: (input: {
		readonly env: NodeJS.ProcessEnv;
		readonly hoboHome: string;
		readonly cwd: string;
		readonly simulate: boolean;
		readonly host: string;
		readonly port: number;
		readonly log: (line: string) => void;
		/** Topology files (`--yard`, HOBO_CD_TOPOLOGY). */
		readonly topologyFiles?: readonly string[];
	}) => Promise<
		| {
				readonly ok: true;
				readonly url: string;
				readonly port: number;
				close(): Promise<void>;
		  }
		| {
				readonly ok: false;
				readonly code: string;
				readonly message: string;
				readonly remediation: readonly string[];
		  }
	>;
}

/** Default `hobo serve cd`: open the composed CD runtime and start the service. */
async function defaultServeCd(
	input: Parameters<NonNullable<ServeControlCommandDeps["serveCd"]>>[0],
): ReturnType<NonNullable<ServeControlCommandDeps["serveCd"]>> {
	const { openCdRuntime } = await import("./cd-runtime.js");
	const runtime = await openCdRuntime({
		env: input.env,
		home: input.hoboHome,
		cwd: input.cwd,
		simulate: input.simulate,
		...(input.topologyFiles
			? { topologyFiles: input.topologyFiles }
			: undefined),
	});
	if (!runtime.ok) {
		const first = runtime.reasons[0];
		return {
			ok: false,
			code: first?.code ?? "cd-serve-refused",
			message: first?.message ?? "the CD runtime could not be composed",
			remediation: runtime.reasons.map((r) => r.remediation),
		};
	}
	const { startCdServer } = await import("./cd-serve.js");
	const server = await startCdServer({
		runtime: runtime.value,
		host: input.host,
		port: input.port,
		log: input.log,
	});
	return {
		ok: true,
		url: server.url,
		port: server.port,
		close: () => server.close(),
	};
}

export function createServeControlCommand(
	deps: ServeControlCommandDeps = {},
): CommandModule {
	return {
		implemented: true,
		async run({ args, flags }) {
			const f = cdFlagsOf(flags);
			const env = deps.env ?? process.env;
			const target = args[0] ?? "control";
			if (target === "cd") return serveCd(deps, f, env);
			if (target !== "control") {
				return {
					ok: false,
					code: "HOBO_SERVE_USAGE",
					message: `hobo serve: unknown target '${target}' (supported: control, cd)`,
					remediation: [
						"hobo serve control [--port 8790] [--demo] [--demo-seed 42]",
						"hobo serve cd [--port 8791] [--host 127.0.0.1] [--simulate]",
					],
					data: {
						usage: "hobo serve control [--port 8790] [--demo] [--demo-seed 42]",
					},
				};
			}
			const hoboHome =
				deps.hoboHome ??
				(isJsonString(f.home) && f.home.length > 0
					? f.home
					: defaultHoboHome(env));
			const port =
				deps.port ??
				(isJsonNumber(f.port)
					? f.port
					: isJsonString(f.port)
						? Number(f.port)
						: Number(env.HOBO_CONTROL_PORT ?? 8790));
			const host = deps.host ?? (isJsonString(f.host) ? f.host : "127.0.0.1");
			const log = deps.log ?? ((line: string) => console.error(line));
			const demo =
				deps.demo ?? (f.demo === true || env.HOBO_CONTROL_DEMO === "1");
			const seedFlag = isJsonString(f.demoSeed)
				? Number(f.demoSeed)
				: Number.NaN;
			const seedEnv = Number(env.HOBO_CONTROL_DEMO_SEED);
			const demoSeed =
				deps.demoSeed ??
				(Number.isFinite(seedFlag)
					? seedFlag
					: Number.isFinite(seedEnv)
						? seedEnv
						: undefined);

			const server = await createControlApiServer({
				hoboHome,
				host,
				port: Number.isFinite(port) ? port : 8790,
				demo,
				...(demoSeed === undefined ? undefined : { demoSeed }),
			});
			log(
				`hobo serve control: ${server.url} (HOBO_HOME=${hoboHome}) yard=/v1/yard/snapshot stream=/v1/yard/stream world=/v1/world/snapshot otlp=/v1/otlp${demo ? ` demo=on seed=${server.demoSeed}` : ""}`,
			);

			if (deps.once) {
				await server.close();
				return {
					ok: true,
					message: `hobo serve control: bound ${server.url}`,
					data: { url: server.url, port: server.port, hoboHome },
				};
			}

			// Hold process open until signal (local serve path).
			await new Promise<void>((resolve, reject) => {
				const stop = () => {
					process.removeListener("SIGINT", stop);
					process.removeListener("SIGTERM", stop);
					void server.close().then(resolve, reject);
				};
				process.once("SIGINT", stop);
				process.once("SIGTERM", stop);
			});
			return {
				ok: true,
				message: `hobo serve control: stopped`,
				data: { url: server.url },
			};
		},
	};
}

async function serveCd(
	deps: ServeControlCommandDeps,
	f: JsonObject,
	env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
	const hoboHome =
		deps.hoboHome ??
		(isJsonString(f.home) && f.home.length > 0 ? f.home : defaultHoboHome(env));
	const port =
		deps.port ??
		(isJsonNumber(f.port)
			? f.port
			: isJsonString(f.port)
				? Number(f.port)
				: Number(env.HOBO_CD_PORT ?? 8791));
	const host = deps.host ?? (isJsonString(f.host) ? f.host : "127.0.0.1");
	const log = deps.log ?? ((line: string) => console.error(line));
	const simulate = f.simulate === true || f.simulate === "true";
	const started = await (deps.serveCd ?? defaultServeCd)({
		env,
		hoboHome,
		cwd: isJsonString(f.cwd) ? f.cwd : process.cwd(),
		simulate,
		host,
		port: Number.isFinite(port) ? port : 8791,
		log,
		topologyFiles: topologyFilesOf(f, env),
	});
	if (!started.ok)
		return {
			ok: false,
			status: "refused",
			code: started.code,
			message: `hobo serve cd: ${started.message}`,
			remediation: [...started.remediation],
			data: { target: "cd", simulated: simulate },
		};
	if (deps.once) {
		await started.close();
		return {
			ok: true,
			code: "HOBO_SERVE_CD_BOUND",
			message: `hobo serve cd: bound ${started.url}`,
			data: {
				url: started.url,
				port: started.port,
				hoboHome,
				simulated: simulate,
			},
		};
	}
	await new Promise<void>((resolve, reject) => {
		const stop = () => {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
			void started.close().then(resolve, reject);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
	return {
		ok: true,
		code: "HOBO_SERVE_CD_STOPPED",
		message: "hobo serve cd: drained and stopped",
		data: { url: started.url, simulated: simulate },
	};
}
