import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fromJsonString } from "@bufbuild/protobuf";
import { parseRelativePath } from "@hobo/ci/execution";
import { type CheckConfig, CheckConfigSchema } from "./_generated/checks_pb.js";

/** Immutable refinement of the protobuf configuration, parsed once at the edge. */
export type DaggerCheckConfig = Readonly<
	Omit<CheckConfig, "filters" | "skip">
> & {
	readonly filters: readonly string[];
	readonly skip: readonly string[];
};

/** Native 1.x checks deliberately accept only operator-owned engines. */
export function parseDaggerCheckConfig(json: string): DaggerCheckConfig {
	const config = fromJsonString(CheckConfigSchema, json);
	config.engine ||= "local";
	config.workspace ||= ".";
	config.timeoutSeconds ||= 900;
	if (!/^1\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?$/.test(config.cliVersion))
		throw new Error("cliVersion must pin a Dagger 1.x CLI version");
	if (
		config.engine.includes("\0") ||
		(config.engine !== "local" &&
			!/^(?:(?:image|container)(?:\+(?:docker|podman|apple|finch|nerdctl))?|unix|tcp|tls|ssh|kube-pod):\/\/\S+$/.test(
				config.engine,
			))
	)
		throw new Error("engine must be local or an explicit non-Cloud engine URI");
	if (config.workspace !== ".") parseRelativePath(config.workspace);
	for (const filter of [...config.filters, ...config.skip]) {
		if (!/^[^-\s][^\s]*$/.test(filter) || filter.includes("\0"))
			throw new Error("check selectors must be nonempty links, not flags");
	}
	if (config.parallel > 256)
		throw new Error("parallel must be between 0 and 256");
	if (config.timeoutSeconds > 86400)
		throw new Error("timeoutSeconds must be at most 86400");
	if (
		config.environment &&
		!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(config.environment)
	)
		throw new Error("environment must name a workspace overlay");
	return Object.freeze({
		...config,
		filters: Object.freeze([...config.filters]),
		skip: Object.freeze([...config.skip]),
	});
}

/** Reviewable argv; no process, engine, or network side effects. */
export function daggerCheckArgs(
	config: DaggerCheckConfig,
	cwd = process.cwd(),
): string[] {
	const engine =
		config.engine === "local"
			? `image://registry.dagger.io/engine:v${config.cliVersion}`
			: config.engine;
	return [
		"check",
		`--engine=${engine}`,
		`--workspace=${resolve(cwd, config.workspace)}`,
		"--progress=plain",
		`--parallel=${config.parallel}`,
		...(config.environment ? [`--env=${config.environment}`] : []),
		...(config.failFast ? ["--fail-fast"] : []),
		...config.skip.map((link) => `--skip=${link}`),
		"--",
		...config.filters,
	];
}

export interface DaggerCheckRunOptions {
	readonly cwd?: string;
	/** Operator-selected executable; never read from repository configuration. */
	readonly executable?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
}

export class DaggerCheckTimeoutError extends Error {
	constructor(seconds: number) {
		super(`Dagger checks exceeded their ${seconds} second deadline`);
		this.name = "DaggerCheckTimeoutError";
	}
}

/**
 * Runs native checks and forwards their logs and exit code. This is a local CLI
 * entrypoint, not a scheduled pipeline session or a remote stop acknowledgment.
 */
export async function runDaggerChecks(
	config: DaggerCheckConfig,
	options: DaggerCheckRunOptions = {},
): Promise<number> {
	options.signal?.throwIfAborted();
	const cwd = resolve(options.cwd ?? process.cwd());
	const executable = options.executable ?? "dagger";
	const workspaceConfig = resolve(cwd, config.workspace, "dagger.toml");
	if (!(await stat(workspaceConfig).catch(() => undefined))?.isFile())
		throw new Error(
			`Dagger workspace configuration not found: ${workspaceConfig}`,
		);
	const deadline = new AbortController();
	const timer = setTimeout(
		() => deadline.abort(new DaggerCheckTimeoutError(config.timeoutSeconds)),
		config.timeoutSeconds * 1000,
	);
	timer.unref();
	const signal = options.signal
		? AbortSignal.any([options.signal, deadline.signal])
		: deadline.signal;
	let settings: string | undefined;
	try {
		settings = await mkdtemp(join(tmpdir(), "hobo-dagger-checks-"));
		signal.throwIfAborted();
		// Tokens alone are insufficient: the CLI also reads a saved Cloud login.
		// Keep proxy, CA, Docker and other toolchain settings in the child only.
		const env: NodeJS.ProcessEnv = {
			...(options.env ?? process.env),
		};
		for (const key of Object.keys(env)) {
			const normalized = key.toUpperCase();
			if (
				normalized.startsWith("DAGGER_CLOUD_") ||
				normalized.startsWith("DAGGER_SESSION_") ||
				normalized === "DAGGER_ENGINE" ||
				normalized === "DAGGER_ENV" ||
				normalized === "_EXPERIMENTAL_DAGGER_RUNNER_HOST" ||
				normalized === "XDG_CONFIG_HOME" ||
				normalized === "DAGGER_CONFIG"
			)
				delete env[key];
		}
		env.XDG_CONFIG_HOME = settings;
		// Avoid inherited per-user module settings; the workspace remains canonical.
		env.DAGGER_CONFIG = join(settings, "config.toml");
		await writeFile(env.DAGGER_CONFIG, "");
		const { stdout } = await promisify(execFile)(executable, ["version"], {
			cwd,
			env,
			signal,
			timeout: 10_000,
			killSignal: "SIGKILL",
			maxBuffer: 16 * 1024,
		});
		const actualVersion = stdout.match(
			/^(?:dagger |version:\s*)v([^\s]+)(?:[ \t].*)?$/m,
		)?.[1];
		if (actualVersion !== config.cliVersion)
			throw new Error(
				`Install Dagger CLI v${config.cliVersion} to match cliVersion (found ${actualVersion ?? "unrecognized version output"})`,
			);
		signal.throwIfAborted();
		return await new Promise<number>((done, reject) => {
			const child = spawn(executable, daggerCheckArgs(config, cwd), {
				cwd,
				env,
				detached: process.platform !== "win32",
				stdio: "inherit",
				shell: false,
			});
			let failure: Error | undefined;
			let escalation: ReturnType<typeof setTimeout> | undefined;
			const stop = (stopSignal: NodeJS.Signals) => {
				if (process.platform !== "win32" && child.pid) {
					try {
						process.kill(-child.pid, stopSignal);
						return;
					} catch {
						// The owned process group may have exited; use the child handle.
					}
				}
				child.kill(stopSignal);
			};
			const abort = () => {
				stop("SIGTERM");
				escalation ??= setTimeout(() => stop("SIGKILL"), 5000);
				escalation.unref();
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			child.once("error", (error) => {
				failure = error;
			});
			child.once("close", (code, exitSignal) => {
				// Transport children belong to this invocation, including on success.
				stop("SIGKILL");
				clearTimeout(escalation);
				signal.removeEventListener("abort", abort);
				if (signal.aborted) reject(signal.reason);
				else if (failure) reject(failure);
				else if (exitSignal)
					reject(new Error(`Dagger CLI stopped by ${exitSignal}`));
				else done(code ?? 1);
			});
		});
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		throw error;
	} finally {
		clearTimeout(timer);
		if (settings) await rm(settings, { recursive: true, force: true });
	}
}
