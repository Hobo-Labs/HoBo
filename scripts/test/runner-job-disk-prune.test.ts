import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DF_SAMPLE_TIMEOUT_MS,
	DOCKER_COMMAND_TIMEOUT_MS,
	runDocker,
	sampleAvailBytes,
} from "../ci/runner-job-disk-prune.mts";
import {
	DEFAULT_RUNNER_DISK_HEADROOM_GB,
	type DockerCommandResult,
	executeRunnerJobDiskPrune,
	jobDiskSamplePath,
	parseDfAvailBytes,
	type RunnerDiskPruneIo,
	runnerDiskHeadroomBytes,
} from "../lib/runner-job-disk-prune.mts";

const GIB = 1024 * 1024 * 1024;
const root = join(import.meta.dirname, "..", "..");
const DOCKER_ROOT = "/var/lib/docker";
const WORKER_REF = "ghcr.io/acme/hobo-ci-worker:local";

function ok(stdout = ""): DockerCommandResult {
	return { status: 0, stdout, stderr: "" };
}

function capture(
	env: Readonly<Record<string, string | undefined>>,
	io: Partial<RunnerDiskPruneIo> &
		Pick<RunnerDiskPruneIo, "sample" | "dockerAvailable">,
) {
	const logs: string[] = [];
	const warnings: string[] = [];
	const docker: string[][] = [];
	const code = executeRunnerJobDiskPrune(env, "/work", {
		sample: io.sample,
		dockerAvailable: io.dockerAvailable,
		docker: (args) => {
			docker.push([...args]);
			return (
				io.docker?.(args) ?? ok(args[0] === "info" ? `${DOCKER_ROOT}\n` : "")
			);
		},
		log: (message) => {
			logs.push(message);
		},
		warn: (message) => {
			warnings.push(message);
		},
	});
	return { code, logs, warnings, docker };
}

function commands(docker: string[][]): string[] {
	return docker.map((args) => args.join(" "));
}

function selfHosted(extra: Readonly<Record<string, string | undefined>> = {}) {
	return {
		RUNNER_ENVIRONMENT: "self-hosted",
		GITHUB_WORKSPACE: "/job",
		...extra,
	};
}

function lowThenOk(): (path: string) => number {
	const seen = new Map<string, number>();
	return (path) => {
		const count = (seen.get(path) ?? 0) + 1;
		seen.set(path, count);
		if (count > 1) return 20 * GIB;
		return path === DOCKER_ROOT ? 20 * GIB : 1;
	};
}

describe("runner job disk prune", () => {
	it("keeps tagged worker and other prepared images under disk pressure", () => {
		const images = new Map([
			[WORKER_REF, "worker"],
			["another-job:prepared", "other"],
		]);
		const result = capture(
			selfHosted({ HOBO_CI_WORKER_IMAGE_REF: WORKER_REF }),
			{
				dockerAvailable: true,
				sample: lowThenOk(),
				docker: (args) => {
					if (args[0] === "info") return ok(`${DOCKER_ROOT}\n`);
					if (args[0] === "image" && args[1] === "inspect")
						return images.has(args[2] ?? "")
							? ok()
							: { status: 1, stdout: "", stderr: "missing" };
					if (args[0] === "tag") {
						const image = images.get(args[1] ?? "");
						if (!image) return { status: 1, stdout: "", stderr: "missing" };
						images.set(args[2] ?? "", image);
					}
					if (args[0] === "rmi") images.delete(args[1] ?? "");
					if (
						args[0] === "image" &&
						args[1] === "prune" &&
						args.some((arg) => arg === "-a" || arg === "--all" || arg === "-af")
					)
						images.clear();
					return ok();
				},
			},
		);
		assert.equal(result.code, 0);
		assert.equal(images.get(WORKER_REF), "worker");
		assert.equal(images.get("another-job:prepared"), "other");
	});

	it("does not prune a worker available only by digest", () => {
		const digest = `ghcr.io/acme/hobo-ci-worker@sha256:${"ab".repeat(32)}`;
		let present = true;
		const result = capture(selfHosted({ HOBO_CI_WORKER_IMAGE_REF: digest }), {
			dockerAvailable: true,
			sample: lowThenOk(),
			docker: (args) => {
				if (args[0] === "info") return ok(`${DOCKER_ROOT}\n`);
				if (args[0] === "image" && args[1] === "prune") present = false;
				return ok();
			},
		});
		assert.equal(result.code, 0);
		assert.equal(present, true);
	});

	it("defaults headroom to 12 GiB and rejects junk", () => {
		assert.equal(DEFAULT_RUNNER_DISK_HEADROOM_GB, 12);
		assert.equal(runnerDiskHeadroomBytes(undefined), 12 * GIB);
		assert.equal(runnerDiskHeadroomBytes(""), 12 * GIB);
		assert.equal(runnerDiskHeadroomBytes(" 12 "), 12 * GIB);
		assert.equal(runnerDiskHeadroomBytes("0012"), 12 * GIB);
		for (const junk of ["0", "-1", "1.5", "12GB", "soon", "1e2"]) {
			assert.throws(
				() => runnerDiskHeadroomBytes(junk),
				/HOBO_CI_RUNNER_DISK_HEADROOM_GB/u,
				junk,
			);
		}
	});

	it("reads the last df avail line", () => {
		assert.equal(parseDfAvailBytes("     Avail\n12884901888\n"), 12 * GIB);
		assert.throws(() => parseDfAvailBytes("Avail\n"), /invalid df avail/u);
		assert.throws(() => parseDfAvailBytes("nope"), /invalid df avail/u);
	});

	it("samples the bind-mounted workspace when Actions set one", () => {
		assert.equal(
			jobDiskSamplePath("/runner/work/HoBo/HoBo", "/work"),
			"/runner/work/HoBo/HoBo",
		);
		assert.equal(jobDiskSamplePath("  ", "/work"), "/work");
		assert.equal(jobDiskSamplePath(undefined, "/work"), "/work");
	});

	it("no-ops unless the runner is self-hosted", () => {
		for (const runnerEnvironment of [undefined, "github-hosted", ""]) {
			const result = capture(
				{
					RUNNER_ENVIRONMENT: runnerEnvironment,
					HOBO_CI_RUNNER_DISK_HEADROOM_GB: "nope",
					HOBO_CI_WORKER_IMAGE_REF: WORKER_REF,
				},
				{
					dockerAvailable: true,
					sample: () => {
						throw new Error("df should not run");
					},
				},
			);
			assert.equal(result.code, 0, runnerEnvironment);
			assert.deepEqual(result.docker, []);
			assert.equal(result.warnings.length, 0);
			assert.match(result.logs.join("\n"), /skipped \(RUNNER_ENVIRONMENT=/u);
		}
	});

	it("leaves docker alone when both paths meet the default 12 GiB", () => {
		const result = capture(
			selfHosted({ HOBO_CI_WORKER_IMAGE_REF: WORKER_REF }),
			{
				dockerAvailable: true,
				sample: () => 12 * GIB,
			},
		);
		assert.equal(result.code, 0);
		assert.deepEqual(commands(result.docker), ["info -f {{.DockerRootDir}}"]);
		assert.match(
			result.logs.join("\n"),
			/before df dockerRoot=\/var\/lib\/docker avail=12884901888 workspace=\/job avail=12884901888 need=12884901888/u,
		);
		assert.match(result.logs.join("\n"), /headroom ok/u);
		assert.doesNotMatch(result.logs.join("\n"), /after df/u);
		assert.equal(result.warnings.length, 0);
	});

	it("prunes stale builder cache when either path is under the headroom", () => {
		const cases = [
			{ dockerRoot: 12 * GIB - 1, workspace: 20 * GIB, low: "dockerRoot" },
			{ dockerRoot: 20 * GIB, workspace: 12 * GIB - 1, low: "workspace" },
			{ dockerRoot: 1, workspace: 1, low: "dockerRoot,workspace" },
		];
		for (const disk of cases) {
			const dockerRoot = [disk.dockerRoot, 20 * GIB];
			const workspace = [disk.workspace, 20 * GIB];
			const result = capture(
				selfHosted({ HOBO_CI_RUNNER_DISK_HEADROOM_GB: "12" }),
				{
					dockerAvailable: true,
					sample: (path) => {
						const queue =
							path === DOCKER_ROOT
								? dockerRoot
								: path === "/job"
									? workspace
									: undefined;
						const next = queue?.shift();
						if (next === undefined) {
							throw new Error(`unexpected sample ${path}`);
						}
						return next;
					},
				},
			);
			assert.equal(result.code, 0, disk.low);
			assert.deepEqual(commands(result.docker), [
				"info -f {{.DockerRootDir}}",
				"builder prune --force --filter until=24h --keep-storage 4GB",
			]);
			assert.match(
				result.logs.join("\n"),
				new RegExp(
					`headroom low ${disk.low}; pruning stale builder cache`,
					"u",
				),
			);
			assert.match(result.logs.join("\n"), /before df /u);
			assert.match(
				result.logs.join("\n"),
				/after df dockerRoot=\/var\/lib\/docker avail=21474836480 workspace=\/job avail=21474836480 need=12884901888/u,
			);
			assert.equal(result.warnings.length, 0, disk.low);
		}
	});

	it("leaves tagged images alone regardless of the worker reference", () => {
		const digest = `ghcr.io/acme/hobo-ci-worker@sha256:${"ab".repeat(32)}`;
		for (const ref of [WORKER_REF, digest, "", "not a ref"]) {
			const result = capture(selfHosted({ HOBO_CI_WORKER_IMAGE_REF: ref }), {
				dockerAvailable: true,
				sample: lowThenOk(),
			});
			assert.equal(result.code, 0);
			assert.deepEqual(commands(result.docker), [
				"info -f {{.DockerRootDir}}",
				"builder prune --force --filter until=24h --keep-storage 4GB",
			]);
			assert.equal(result.warnings.length, 0);
		}
	});

	it("prunes from the path that could be sampled when the other df fails", () => {
		const workspaceOnly = capture(selfHosted(), {
			dockerAvailable: true,
			sample: (path) => {
				if (path === DOCKER_ROOT) throw new Error("docker root unmounted");
				return 1;
			},
		});
		assert.equal(workspaceOnly.code, 0);
		assert.match(
			commands(workspaceOnly.docker).join("\n"),
			/builder prune --force --filter until=24h --keep-storage 4GB/u,
		);
		assert.match(
			workspaceOnly.warnings.join("\n"),
			/df sample failed path=\/var\/lib\/docker: docker root unmounted/u,
		);
		assert.match(
			workspaceOnly.logs.join("\n"),
			/headroom low workspace; pruning stale builder cache/u,
		);

		const dockerOnly = capture(selfHosted(), {
			dockerAvailable: true,
			sample: (path) => {
				if (path === "/job") throw new Error("workspace unreadable");
				return 1;
			},
		});
		assert.match(
			dockerOnly.logs.join("\n"),
			/headroom low dockerRoot; pruning stale builder cache/u,
		);
	});

	it("warns and continues when Docker is missing or a prune does not free enough", () => {
		const missing = capture(
			selfHosted({ HOBO_CI_RUNNER_DISK_HEADROOM_GB: "1" }),
			{
				dockerAvailable: false,
				sample: (path) => {
					assert.equal(path, "/job");
					return 1;
				},
			},
		);
		assert.equal(missing.code, 0);
		assert.deepEqual(missing.docker, []);
		assert.match(missing.warnings.join("\n"), /docker unavailable/u);
		assert.match(missing.logs.join("\n"), /before df dockerRoot=unavailable/u);
		assert.doesNotMatch(missing.logs.join("\n"), /after df/u);

		const stillShort = capture(
			selfHosted({ HOBO_CI_RUNNER_DISK_HEADROOM_GB: "1" }),
			{
				dockerAvailable: true,
				sample: () => 1,
				docker: (args) => {
					if (args[0] === "info") return ok(`${DOCKER_ROOT}\n`);
					if (args[0] === "builder") {
						return { status: 1, stdout: "", stderr: "builder down" };
					}
					return { status: 2, stdout: "", stderr: "image down" };
				},
			},
		);
		assert.equal(stillShort.code, 0);
		assert.doesNotMatch(commands(stillShort.docker).join("\n"), /image prune/u);
		assert.match(stillShort.warnings.join("\n"), /builder prune failed/u);
		assert.match(stillShort.warnings.join("\n"), /still below headroom/u);
		assert.match(stillShort.logs.join("\n"), /after df /u);
	});

	it("warns and skips an invalid headroom and fails open when df cannot sample", () => {
		const invalid = capture(
			selfHosted({ HOBO_CI_RUNNER_DISK_HEADROOM_GB: "0" }),
			{
				dockerAvailable: true,
				sample: () => {
					throw new Error("df should not run");
				},
			},
		);
		assert.equal(invalid.code, 0);
		assert.match(
			invalid.warnings.join("\n"),
			/HOBO_CI_RUNNER_DISK_HEADROOM_GB/u,
		);
		assert.deepEqual(invalid.docker, []);
		assert.deepEqual(invalid.logs, []);

		const unreadable = capture(selfHosted(), {
			dockerAvailable: true,
			sample: () => {
				throw new Error("permission denied");
			},
		});
		assert.equal(unreadable.code, 0);
		assert.match(
			unreadable.warnings.join("\n"),
			/df sample failed path=\/var\/lib\/docker: permission denied/u,
		);
		assert.match(
			unreadable.warnings.join("\n"),
			/df sample failed path=\/job: permission denied/u,
		);
		assert.deepEqual(commands(unreadable.docker), [
			"info -f {{.DockerRootDir}}",
		]);
		assert.match(unreadable.logs.join("\n"), /before df /u);
		assert.doesNotMatch(unreadable.logs.join("\n"), /headroom ok/u);
		assert.doesNotMatch(unreadable.logs.join("\n"), /after df/u);
	});

	it("bounds cache pruning and leaves images alone", () => {
		const source = readFileSync(
			join(root, "scripts/lib/runner-job-disk-prune.mts"),
			"utf8",
		);
		assert.match(source, /keep-storage/u);
		assert.doesNotMatch(source, /"-af"/u);
	});

	it("stops a hung df or docker command at its timeout", () => {
		assert.ok(DF_SAMPLE_TIMEOUT_MS >= 10_000);
		assert.ok(DOCKER_COMMAND_TIMEOUT_MS >= 30_000);
		const cli = readFileSync(
			join(root, "scripts/ci/runner-job-disk-prune.mts"),
			"utf8",
		);
		assert.match(cli, /timeout: timeoutMs/u);
		const bin = mkdtempSync(join(tmpdir(), "hobo-job-disk-timeout-"));
		const hang = ["#!/bin/sh", "exec /bin/sleep 5", ""].join("\n");
		writeFileSync(join(bin, "df"), hang, { mode: 0o755 });
		writeFileSync(join(bin, "docker"), hang, { mode: 0o755 });
		const previousPath = process.env.PATH;
		try {
			process.env.PATH = `${bin}:${previousPath ?? ""}`;
			const started = Date.now();
			assert.throws(
				() => sampleAvailBytes("/var/lib/docker", 400),
				/ETIMEDOUT|timed out/iu,
			);
			const info = runDocker(["info"], 400);
			assert.ok(info.error);
			const prune = runDocker(["builder", "prune", "--force"], 400);
			assert.ok(prune.error);
			assert.ok(Date.now() - started < 3000);
		} finally {
			process.env.PATH = previousPath;
			rmSync(bin, { recursive: true, force: true });
		}
	});

	it("preflight runs the prune on self-hosted runners before the untagged image sweep", () => {
		const action = readFileSync(
			join(root, ".github/actions/ci-runner-preflight/action.yml"),
			"utf8",
		);
		const disk = action.indexOf("scripts/ci/runner-job-disk-prune.mts");
		const images = action.indexOf(
			"Prune stale untagged images and stopped job containers",
		);
		assert.ok(
			disk > 0 && images > disk,
			"job disk prune step must precede the image prune",
		);
		assert.match(
			action,
			/RUNNER_ENVIRONMENT: \$\{\{ runner\.environment \}\}/u,
		);
		assert.match(
			action,
			/if: runner\.environment == 'self-hosted'[\s\S]*?runner-job-disk-prune\.mts/u,
		);
		assert.match(action, /HOBO_CI_RUNNER_DISK_HEADROOM_GB/u);
		assert.match(action, /default 12/u);
		assert.doesNotMatch(action, /keep-storage/u);
	});

	function listen(path: string): Promise<Server> {
		const server = createServer();
		return new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => resolve(server));
		});
	}

	function runCli(
		env: Readonly<Record<string, string | undefined>>,
		bin: string,
	) {
		const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
		for (const key of [
			"HOBO_CI_RUNNER_DISK_HEADROOM_GB",
			"HOBO_CI_WORKER_IMAGE_REF",
			"HOBO_CI_DOCKER_SOCK",
			"DF_MODE",
		]) {
			if (!(key in env)) delete merged[key];
		}
		merged.PATH = `${bin}:${process.env.PATH ?? ""}`;
		return spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				"scripts/ci/runner-job-disk-prune.mts",
			],
			{
				cwd: root,
				encoding: "utf8",
				env: merged,
			},
		);
	}

	it("the CLI prunes a self-hosted runner when stubbed df on either path is under 12 GiB", async () => {
		const bin = mkdtempSync(join(tmpdir(), "hobo-job-disk-"));
		const calls = join(bin, "calls");
		const sock = join(bin, "docker.sock");
		const low = String(12 * GIB - 1);
		const high = String(13 * GIB);
		writeFileSync(
			join(bin, "df"),
			[
				"#!/bin/sh",
				`echo "df $*" >> "${calls}"`,
				'echo "Avail"',
				'if [ "$DF_MODE" = low ]; then',
				`  n=$(grep -c '^df ' "${calls}")`,
				`  if [ "$n" -le 2 ]; then echo "${low}"; else echo "${high}"; fi`,
				"else",
				`  echo "${high}"`,
				"fi",
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		writeFileSync(
			join(bin, "docker"),
			[
				"#!/bin/sh",
				`echo "docker $*" >> "${calls}"`,
				'if [ "$1" = info ]; then echo "/var/lib/docker"; exit 0; fi',
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const server = await listen(sock);
		try {
			const hosted = runCli(
				{
					RUNNER_ENVIRONMENT: "github-hosted",
					HOBO_CI_DOCKER_SOCK: sock,
					GITHUB_WORKSPACE: bin,
					DF_MODE: "low",
					HOBO_CI_WORKER_IMAGE_REF: WORKER_REF,
				},
				bin,
			);
			assert.equal(hosted.status, 0, hosted.stderr);
			assert.match(
				hosted.stdout,
				/skipped \(RUNNER_ENVIRONMENT=github-hosted\)/u,
			);
			assert.equal(hosted.stderr, "");
			assert.equal(existsSync(calls), false);

			const quiet = runCli(
				{
					RUNNER_ENVIRONMENT: "self-hosted",
					HOBO_CI_DOCKER_SOCK: sock,
					GITHUB_WORKSPACE: bin,
					DF_MODE: "high",
					HOBO_CI_WORKER_IMAGE_REF: WORKER_REF,
				},
				bin,
			);
			assert.equal(quiet.status, 0, quiet.stderr);
			assert.match(quiet.stdout, /before df /u);
			assert.match(quiet.stdout, /headroom ok/u);
			assert.doesNotMatch(quiet.stdout, /after df/u);
			assert.equal(quiet.stderr, "");
			assert.doesNotMatch(readFileSync(calls, "utf8"), /prune/u);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /image inspect/u);

			writeFileSync(calls, "");
			const missingSock = runCli(
				{
					RUNNER_ENVIRONMENT: "self-hosted",
					HOBO_CI_DOCKER_SOCK: join(bin, "missing.sock"),
					GITHUB_WORKSPACE: bin,
					DF_MODE: "low",
				},
				bin,
			);
			assert.equal(missingSock.status, 0, missingSock.stderr);
			assert.match(missingSock.stderr, /::warning::.*docker unavailable/u);
			assert.match(missingSock.stdout, /dockerRoot=unavailable/u);
			assert.doesNotMatch(readFileSync(calls, "utf8"), /^docker /mu);

			writeFileSync(calls, "");
			const reclaimed = runCli(
				{
					RUNNER_ENVIRONMENT: "self-hosted",
					HOBO_CI_DOCKER_SOCK: sock,
					GITHUB_WORKSPACE: bin,
					DF_MODE: "low",
					HOBO_CI_WORKER_IMAGE_REF: WORKER_REF,
				},
				bin,
			);
			assert.equal(reclaimed.status, 0, reclaimed.stderr);
			assert.equal(reclaimed.stderr, "");
			const recorded = readFileSync(calls, "utf8")
				.split("\n")
				.filter((line) => line.length > 0);
			assert.deepEqual(recorded, [
				"docker info -f {{.DockerRootDir}}",
				"df -B1 --output=avail -- /var/lib/docker",
				`df -B1 --output=avail -- ${bin}`,
				"docker builder prune --force --filter until=24h --keep-storage 4GB",
				"df -B1 --output=avail -- /var/lib/docker",
				`df -B1 --output=avail -- ${bin}`,
			]);
			assert.match(
				reclaimed.stdout,
				new RegExp(`before df .*avail=${low}`, "u"),
			);
			assert.match(
				reclaimed.stdout,
				new RegExp(`after df .*avail=${high}`, "u"),
			);
			assert.match(reclaimed.stdout, /dockerRoot=\/var\/lib\/docker/u);
			assert.match(reclaimed.stdout, new RegExp(`workspace=${bin}`, "u"));
		} finally {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			rmSync(bin, { recursive: true, force: true });
		}
	});
});
