import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { DOCKER_IMAGES } from "./docker-images.js";
import {
	type DockerCampaignReport,
	parseDockerCampaignReport,
} from "./docker-report.js";

const { DEPENDENCY_IMAGES, RESTLER_IMAGE, RESTLER_REVISION } = DOCKER_IMAGES;

type ProcessOptions = {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly timeout: number;
};
type ProcessResult = {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
};

function run(
	binary: string,
	args: readonly string[],
	options: ProcessOptions,
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let interrupted = false;
		let killer: NodeJS.Timeout | undefined;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = (stdout + chunk.toString()).slice(-65_536);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-65_536);
		});
		const stop = () => {
			child.kill("SIGTERM");
			if (!killer) killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
		};
		const interrupt = () => {
			interrupted = true;
			stop();
		};
		process.once("SIGINT", interrupt);
		process.once("SIGTERM", interrupt);
		const timeout = setTimeout(() => {
			timedOut = true;
			stop();
		}, options.timeout);
		const clear = () => {
			clearTimeout(timeout);
			if (killer) clearTimeout(killer);
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
		};
		child.once("error", (error) => {
			clear();
			reject(error);
		});
		child.once("close", (status) => {
			clear();
			if (timedOut) reject(new Error("fuzz campaign process timed out"));
			else if (interrupted) reject(new Error("fuzz campaign interrupted"));
			else resolve({ status, stdout, stderr });
		});
	});
}

async function checked(
	binary: string,
	args: readonly string[],
	options: ProcessOptions,
	includeErrors = false,
): Promise<string> {
	const result = await run(binary, args, options);
	if (result.status !== 0)
		throw new Error(
			`${binary} failed (${result.status})${includeErrors ? `: ${result.stderr.slice(-4000)}` : ""}`,
		);
	return result.stdout.trim();
}

async function prepareImages(
	directory: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	const options = { cwd: directory, env, timeout: 600_000 };
	const docker = ["--host", "unix:///var/run/docker.sock"];
	for (const image of DEPENDENCY_IMAGES) {
		const inspect = await run(
			"docker",
			[...docker, "image", "inspect", image],
			options,
		);
		if (inspect.status !== 0)
			await checked("docker", [...docker, "pull", image], options);
	}
	const inspect = await run(
		"docker",
		[
			...docker,
			"image",
			"inspect",
			"--format",
			'{{ index .Config.Labels "org.opencontainers.image.revision" }}',
			RESTLER_IMAGE,
		],
		options,
	);
	if (inspect.status === 0) {
		if (inspect.stdout.trim() !== RESTLER_REVISION)
			throw new Error("RESTler image revision did not match its pin");
		return;
	}
	const checkout = join(directory, "restler");
	await mkdir(checkout);
	const gitOptions = {
		...options,
		env: {
			...env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		},
	};
	await checked("git", ["init", checkout], gitOptions);
	await checked(
		"git",
		[
			"-C",
			checkout,
			"fetch",
			"--depth",
			"1",
			"https://github.com/microsoft/restler-fuzzer.git",
			RESTLER_REVISION,
		],
		gitOptions,
	);
	await checked(
		"git",
		["-C", checkout, "checkout", "--detach", "FETCH_HEAD"],
		gitOptions,
	);
	if (
		(await checked(
			"git",
			["-C", checkout, "rev-parse", "HEAD"],
			gitOptions,
		)) !== RESTLER_REVISION
	)
		throw new Error("RESTler source revision did not match its pin");
	await copyFile(
		"/etc/ssl/certs/ca-certificates.crt",
		join(checkout, "host-ca.crt"),
	);
	const dockerfile = fileURLToPath(
		new URL("../contracts/faults/Restler.Dockerfile", import.meta.url),
	);
	const buildArgs = [
		...docker,
		"build",
		"--network",
		"host",
		"--file",
		dockerfile,
		"--tag",
		RESTLER_IMAGE,
		checkout,
	];
	const built = await run("docker", buildArgs, options);
	if (built.status !== 0) {
		await checked("docker", buildArgs, {
			...options,
			env: { ...env, DOCKER_BUILDKIT: "0" },
		});
	}
	const revision = await checked(
		"docker",
		[
			...docker,
			"image",
			"inspect",
			"--format",
			'{{ index .Config.Labels "org.opencontainers.image.revision" }}',
			RESTLER_IMAGE,
		],
		options,
	);
	if (revision !== RESTLER_REVISION)
		throw new Error("built RESTler image revision did not match its pin");
}

export async function runDockerCampaign(): Promise<DockerCampaignReport> {
	const directory = await mkdtemp(join(tmpdir(), "hobo-docker-fuzz-"));
	try {
		const buildConfig = join(directory, "build-config");
		const runtimeConfig = join(directory, "runtime-config");
		await mkdir(buildConfig, { mode: 0o700 });
		await mkdir(runtimeConfig, { mode: 0o700 });
		const proxies = {
			...(process.env.HTTP_PROXY
				? { httpProxy: process.env.HTTP_PROXY }
				: undefined),
			...(process.env.HTTPS_PROXY
				? { httpsProxy: process.env.HTTPS_PROXY }
				: undefined),
			...(process.env.NO_PROXY ? { noProxy: process.env.NO_PROXY } : undefined),
		};
		await writeFile(
			join(buildConfig, "config.json"),
			JSON.stringify({ proxies: { default: proxies } }),
			{ mode: 0o600 },
		);
		const runtimeEnv: NodeJS.ProcessEnv = {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			LANG: "C.UTF-8",
			DOCKER_HOST: "unix:///var/run/docker.sock",
			DOCKER_CONFIG: runtimeConfig,
			TESTCONTAINERS_RYUK_DISABLED: "true",
		};
		const buildEnv = {
			...runtimeEnv,
			DOCKER_CONFIG: buildConfig,
			...(process.env.HTTP_PROXY
				? { HTTP_PROXY: process.env.HTTP_PROXY }
				: undefined),
			...(process.env.HTTPS_PROXY
				? { HTTPS_PROXY: process.env.HTTPS_PROXY }
				: undefined),
			...(process.env.NO_PROXY
				? { NO_PROXY: process.env.NO_PROXY }
				: undefined),
		};
		await prepareImages(directory, buildEnv);
		const source = fileURLToPath(
			new URL("../src/docker-target.ts", import.meta.url),
		);
		const bundle = await build({
			entryPoints: [source],
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node24",
			write: false,
			logLevel: "silent",
		});
		const output = bundle.outputFiles[0];
		if (!output) throw new Error("failed to bundle control simulator");
		const target = join(directory, "target.mjs");
		await writeFile(target, output.contents, { mode: 0o600 });
		const worker = fileURLToPath(
			new URL("../src/docker-worker.ts", import.meta.url),
		);
		const schema = fileURLToPath(
			new URL("../contracts/openapi/control-sim.v1.json", import.meta.url),
		);
		const probe = fileURLToPath(
			new URL("../contracts/faults/probe.py", import.meta.url),
		);
		const registry = fileURLToPath(
			new URL("../contracts/faults/registry.py", import.meta.url),
		);
		const result = await checked(
			process.execPath,
			["--import", "tsx", worker, target, schema, probe, registry],
			{ cwd: dirname(worker), env: runtimeEnv, timeout: 600_000 },
			true,
		);
		return parseDockerCampaignReport(result);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
