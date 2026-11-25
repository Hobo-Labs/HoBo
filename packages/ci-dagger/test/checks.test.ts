import { execFileSync } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pact from "../contracts/checks-cli.pact.json" with { type: "json" };
import { runDaggerCheckCli } from "../src/check-cli.js";
import {
	DaggerCheckTimeoutError,
	daggerCheckArgs,
	parseDaggerCheckConfig,
	runDaggerChecks,
} from "../src/checks.js";

const configJson = {
	cliVersion: "1.0.0-beta.21",
	filters: ["dag://go/packages/tests/test"],
	skip: ["dag://go/lint"],
	parallel: 4,
	failFast: true,
};
const config = parseDaggerCheckConfig(JSON.stringify(configJson));

async function prepareCli(root: string): Promise<string> {
	const executable = join(root, "dagger.ts");
	await writeFile(join(root, "dagger.toml"), "[modules]\n");
	await writeFile(
		executable,
		await readFile(new URL("./fixtures/native-cli.ts", import.meta.url)),
		{ mode: 0o755 },
	);
	return executable;
}

// A hang guard, not a budget: every wait in the process tests is on an event,
// so a slow or stalled host makes them slower and never makes them fail.
const HANG_GUARD_MS = 120_000;

interface Announced {
	readonly pid: number;
	/** Settles once the process has exited and the kernel closed its socket. */
	readonly gone: Promise<void>;
}

interface Probe {
	readonly path: string;
	readonly announced: Promise<Announced>;
	close(): Promise<void>;
}

/** The fixture connects to `path` (`FIXTURE_PROBE`) when it is ready. */
async function listenForProcess(root: string): Promise<Probe> {
	const path =
		process.platform === "win32"
			? join("\\\\?\\pipe", root, "probe")
			: join(root, "probe.sock");
	const server = createServer();
	const sockets = new Set<Socket>();
	const announced = new Promise<Announced>((resolve, reject) => {
		server.once("connection", (socket) => {
			sockets.add(socket);
			const gone = new Promise<void>((done) => {
				socket.once("close", () => done());
			});
			let text = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				text += chunk;
				const end = text.indexOf("\n");
				if (end >= 0) resolve({ pid: Number(text.slice(0, end)), gone });
			});
			socket.once("close", () =>
				reject(new Error("fixture disconnected before announcing its pid")),
			);
		});
	});
	announced.catch(() => {});
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(path, done);
	});
	return {
		path,
		announced,
		close: () =>
			new Promise<void>((done) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => done());
			}),
	};
}

/** The announcement, or why the run ended without one. */
function announcedDuring(
	probe: Probe,
	running: Promise<number>,
): Promise<Announced> {
	return Promise.race([
		probe.announced,
		running.then((code) => {
			throw new Error(`Dagger CLI exited ${code} before the fixture was ready`);
		}),
	]);
}

function killIfLeft(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

describe("native Dagger checks configuration", () => {
	it("accepts the minimal shared schema fixture with local defaults", async () => {
		const minimal = parseDaggerCheckConfig(
			await readFile(
				new URL(
					"../data-models/fixtures/valid/minimal-checks.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect(minimal).toMatchObject({
			engine: "local",
			workspace: ".",
			cliVersion: "1.0.0-beta.21",
			parallel: 0,
			timeoutSeconds: 900,
			filters: [],
			skip: [],
		});
	});
	it.each([
		"nul-engine.json",
		"nul-filter.json",
		"nul-skip.json",
	])("rejects shared invalid schema fixture: %s", async (fixture) => {
		const json = await readFile(
			new URL(`../data-models/fixtures/invalid/${fixture}`, import.meta.url),
			"utf8",
		);
		expect(() => parseDaggerCheckConfig(json)).toThrow();
	});
	it("defaults to local engines and freezes the parsed protobuf view", () => {
		expect(config.engine).toBe("local");
		expect(config.workspace).toBe(".");
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.filters)).toBe(true);
	});
	it.each([
		{ engine: "cloud" },
		{ engine: "https://cloud.dagger.io" },
		{ engine: "tcp://host:1234 --engine=cloud" },
		{ cliVersion: "0.21.11" },
		{ cliVersion: "latest" },
		{ workspace: "../other" },
		{ workspace: "/tmp/other" },
		{ filters: ["--engine=cloud"] },
		{ skip: [""] },
		{ parallel: 257 },
		{ parallel: -1 },
		{ cloud: true },
		{ timeoutSeconds: 86401 },
		{ environment: "--engine=cloud" },
	])("rejects invalid or Cloud configuration: %j", (override) => {
		expect(() =>
			parseDaggerCheckConfig(JSON.stringify({ ...configJson, ...override })),
		).toThrow();
	});
	it("requires an explicit CLI version pin", () => {
		expect(() => parseDaggerCheckConfig("{}")).toThrow(/cliVersion/);
	});
	it("accepts ordinary workspace directory names, including dots and spaces", () => {
		const selected = parseDaggerCheckConfig(
			JSON.stringify({
				...configJson,
				workspace: "apps/my.app/.dagger workspace",
			}),
		);
		expect(daggerCheckArgs(selected)).toContain(
			`--workspace=${join(process.cwd(), "apps/my.app/.dagger workspace")}`,
		);
	});
	it.each([
		"container://dagger-engine",
		"image+podman://registry.dagger.io/engine:v1.0.0-beta.21",
		"container+docker://dagger-engine",
		"image+apple://registry.dagger.io/engine:v1.0.0-beta.21",
		"container+finch://dagger-engine",
		"image+nerdctl://registry.dagger.io/engine:v1.0.0-beta.21",
		"unix:///run/dagger/engine.sock",
		"tcp://engine.internal:1234",
		"tls://engine.internal:1234?ca_path=ca&cert_path=cert&key_path=key",
		"ssh://builder",
		"kube-pod://checks-0?namespace=dagger",
	])("selects the configured customer-owned engine: %s", (engine) => {
		const selected = parseDaggerCheckConfig(
			JSON.stringify({ ...configJson, engine }),
		);
		expect(daggerCheckArgs(selected)).toContain(`--engine=${engine}`);
	});
});

it("executes the subprocess Pact with isolated Cloud settings and preserves failing checks", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-dagger-cli-"));
	try {
		const executable = await prepareCli(root);
		await mkdir(join(root, "dagger"));
		await writeFile(join(root, "dagger", "credentials.json"), "fixture login");
		const env = {
			...process.env,
			XDG_CONFIG_HOME: root,
			DAGGER_CONFIG: join(root, "saved-config.toml"),
			DAGGER_ENGINE: "cloud",
			DAGGER_ENV: "nonexistent-parent-overlay",
			DAGGER_CLOUD_ENGINE: "1",
			DAGGER_CLOUD_TOKEN: "fixture-cloud-token",
			DAGGER_SESSION_PORT: "1234",
			DAGGER_SESSION_TOKEN: "fixture-session-token",
			dagger_cloud_token: "case-variant-cloud-token",
			Dagger_Session_Port: "1",
			xdg_config_home: root,
			_EXPERIMENTAL_DAGGER_RUNNER_HOST: "cloud",
			FIXTURE_PROXY: process.env.HTTPS_PROXY ?? "",
			FIXTURE_CA: process.env.NODE_EXTRA_CA_CERTS ?? "",
		};
		expect(await runDaggerChecks(config, { cwd: root, executable, env })).toBe(
			17,
		);
		const observations = (await readFile(join(root, "observed.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line: string) => JSON.parse(line));
		for (const [index, interaction] of pact.interactions.entries()) {
			const observation = observations[index];
			expect(observation.argv).toEqual(
				interaction.request.contents.argv.map((arg) =>
					arg.replace("WORKSPACE", root),
				),
			);
			expect(observation).toMatchObject({
				savedLogin: false,
				configText: "",
				proxyPreserved: true,
				caPreserved: true,
			});
			for (const key of interaction.request.contents.removedEnvironment ?? [])
				expect(observation.keys).not.toContain(key);
			expect(observation.keys).not.toContain("dagger_cloud_token");
			expect(observation.keys).not.toContain("Dagger_Session_Port");
			expect(observation.keys).not.toContain("xdg_config_home");
			expect(observation.keys).not.toContain("DAGGER_ENV");
			await expect(access(observation.settings)).rejects.toThrow();
		}
		expect(observations).toHaveLength(pact.interactions.length);
		expect(env.DAGGER_ENGINE).toBe("cloud");
		expect(env.XDG_CONFIG_HOME).toBe(root);
		await access(join(root, "dagger", "credentials.json"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects mismatched CLI versions before starting an engine", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-dagger-version-"));
	try {
		const executable = await prepareCli(root);
		await expect(
			runDaggerChecks(config, {
				cwd: root,
				executable,
				env: { ...process.env, FIXTURE_VERSION: "0.21.11" },
			}),
		).rejects.toThrow(/Install Dagger CLI/);
		expect(
			(await readFile(join(root, "observed.jsonl"), "utf8")).trim().split("\n"),
		).toHaveLength(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("plans from the invocation directory without needing Dagger or an engine", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-dagger-plan-"));
	try {
		await mkdir(join(root, ".hobo"));
		await writeFile(
			join(root, ".hobo", "dagger.json"),
			JSON.stringify(configJson),
		);
		let output = "";
		expect(
			await runDaggerCheckCli(["--plan"], {
				env: { INIT_CWD: root },
				executable: "not-installed-dagger",
				write: (text) => {
					output += text;
				},
			}),
		).toBe(0);
		expect(JSON.parse(output)).toEqual({
			executable: "not-installed-dagger",
			args: daggerCheckArgs(config, root),
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("honors an already-aborted request before launching the CLI", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		runDaggerChecks(config, { signal: controller.signal }),
	).rejects.toThrow(/abort/i);
});

it("runs legacy version output and a named workspace overlay with successful exit status", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-dagger-success-"));
	try {
		const executable = await prepareCli(root);
		const selected = parseDaggerCheckConfig(
			JSON.stringify({ ...configJson, environment: "ci", timeoutSeconds: 10 }),
		);
		expect(
			await runDaggerChecks(selected, {
				cwd: root,
				executable,
				env: {
					...process.env,
					FIXTURE_EXIT_CODE: "0",
					FIXTURE_VERSION_OUTPUT: "dagger v1.0.0-beta.21 (legacy)\n",
				},
			}),
		).toBe(0);
		expect(daggerCheckArgs(selected, root)).toContain("--env=ci");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects unrecognized version output even if its second token matches the pin", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-dagger-bad-version-"));
	try {
		const executable = await prepareCli(root);
		await expect(
			runDaggerChecks(config, {
				cwd: root,
				executable,
				env: {
					...process.env,
					FIXTURE_VERSION_OUTPUT: "unrelated v1.0.0-beta.21\n",
				},
			}),
		).rejects.toThrow(/unrecognized version/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects a missing workspace configuration before launching any CLI", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-dagger-no-workspace-"));
	try {
		await expect(
			runDaggerChecks(config, { cwd: root, executable: "not-installed" }),
		).rejects.toThrow(/workspace configuration not found/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("bounds a hung check without a caller-provided abort signal", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-dagger-timeout-"));
	try {
		const executable = await prepareCli(root);
		const selected = parseDaggerCheckConfig(
			JSON.stringify({ ...configJson, timeoutSeconds: 1 }),
		);
		await expect(
			runDaggerChecks(selected, {
				cwd: root,
				executable,
				env: { ...process.env, FIXTURE_WAIT: "1" },
			}),
		).rejects.toBeInstanceOf(DaggerCheckTimeoutError);
		const observation = JSON.parse(
			(await readFile(join(root, "observed.jsonl"), "utf8")).split("\n")[0] ??
				"{}",
		);
		await expect(access(observation.settings)).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it.skipIf(process.platform !== "linux")(
	"stops a transport child even when the CLI exits first on SIGTERM",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-dagger-process-group-"));
		const probe = await listenForProcess(root);
		const controller = new AbortController();
		let running: Promise<number> | undefined;
		let transport: Announced | undefined;
		try {
			const executable = await prepareCli(root);
			running = runDaggerChecks(config, {
				cwd: root,
				executable,
				signal: controller.signal,
				env: { ...process.env, FIXTURE_CHILD: "1", FIXTURE_PROBE: probe.path },
			});
			// Announced only after it ignores SIGTERM, so only the group SIGKILL
			// sent when the CLI closes can end it.
			transport = await announcedDuring(probe, running);
			controller.abort();
			await expect(running).rejects.toThrow(/abort/i);
			await transport.gone;
		} finally {
			controller.abort();
			await running?.catch(() => {});
			killIfLeft(transport?.pid);
			await probe.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	HANG_GUARD_MS,
);

it.skipIf(process.platform === "win32")(
	"rejects a FIFO config without waiting for a writer",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-dagger-fifo-"));
		try {
			const path = join(root, "config.pipe");
			execFileSync("mkfifo", [path]);
			await expect(
				runDaggerCheckCli(["--config", path, "--plan"], { cwd: root }),
			).rejects.toThrow(/must be a file/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

it.skipIf(process.platform !== "linux")(
	"cleans up a background transport after a successful CLI exit",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-dagger-success-group-"));
		const probe = await listenForProcess(root);
		let transport: Announced | undefined;
		try {
			const executable = await prepareCli(root);
			// The fixture CLI exits 0 only after its transport child announced.
			expect(
				await runDaggerChecks(config, {
					cwd: root,
					executable,
					env: {
						...process.env,
						FIXTURE_CHILD: "1",
						FIXTURE_CHILD_PARENT_EXIT: "1",
						FIXTURE_PROBE: probe.path,
					},
				}),
			).toBe(0);
			transport = await probe.announced;
			expect(transport.pid).toBeGreaterThan(0);
			await transport.gone;
		} finally {
			killIfLeft(transport?.pid);
			await probe.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	HANG_GUARD_MS,
);

it(
	"bounds abort cleanup even when the CLI ignores SIGTERM",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-dagger-abort-"));
		const probe = await listenForProcess(root);
		const controller = new AbortController();
		let running: Promise<number> | undefined;
		let cli: Announced | undefined;
		try {
			const executable = await prepareCli(root);
			running = runDaggerChecks(config, {
				cwd: root,
				executable,
				env: {
					...process.env,
					FIXTURE_WAIT: "1",
					FIXTURE_IGNORE_TERM: "1",
					FIXTURE_PROBE: probe.path,
				},
				signal: controller.signal,
			});
			cli = await announcedDuring(probe, running);
			controller.abort();
			await expect(running).rejects.toThrow(/abort/i);
			await cli.gone;
			const observations = await readFile(join(root, "observed.jsonl"), "utf8");
			const first = JSON.parse(observations.split("\n")[0] ?? "{}");
			await expect(access(first.settings)).rejects.toThrow();
		} finally {
			controller.abort();
			await running?.catch(() => {});
			killIfLeft(cli?.pid);
			await probe.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	HANG_GUARD_MS,
);
