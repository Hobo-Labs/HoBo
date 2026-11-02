import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CI_RUNNER_BASE_DOCKERFILE =
	"packages/ci-gh-actions/deploy/ci-runner/base/Dockerfile";
export const CI_RUNNER_BUILD_SCRIPT =
	"packages/ci-gh-actions/deploy/ci-runner/build.sh";
export const CI_RUNNER_SYSTEM_PACKAGES =
	"packages/ci-gh-actions/deploy/ci-runner/system-packages.txt";
export const MISE_TOML = "mise.toml";
export const MISE_LOCK = "mise.lock";

/** @deprecated use CI_RUNNER_BUILD_SCRIPT */
export const CI_RUNNER_DOCKERFILE = CI_RUNNER_BASE_DOCKERFILE;

/** Version tag derived from toolchain lock + base manifest (reproducible rebuild key). */
export function ciRunnerImageVersion(root: string): string {
	const parts = [
		MISE_LOCK,
		MISE_TOML,
		CI_RUNNER_SYSTEM_PACKAGES,
		CI_RUNNER_BASE_DOCKERFILE,
	].map((rel) => readFileSync(join(root, rel)));
	const digest = createHash("sha256")
		.update(Buffer.concat(parts))
		.digest("hex");
	return `v${digest.slice(0, 12)}`;
}

export type ContractCheck = { ok: boolean; name: string; detail: string };

type CommandResult = { ok: boolean; out: string };

function run(cmd: string, args: string[]): CommandResult {
	const r = spawnSync(cmd, args, { encoding: "utf8" });
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	return { ok: r.status === 0, out: out || `(exit ${r.status})` };
}

function parseMiseToolNames(miseToml: string): string[] {
	const names: string[] = [];
	let inTools = false;
	for (const line of miseToml.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "[tools]") {
			inTools = true;
			continue;
		}
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			inTools = false;
			continue;
		}
		if (!inTools || trimmed.startsWith("#")) continue;
		const m = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
		if (m) names.push(m[1]!);
	}
	return names;
}

const SYSTEM_COMMANDS = {
	xz: "xz-utils",
	git: "git",
	curl: "curl",
	ps: "procps",
	docker: "docker.io",
} as const satisfies Record<string, string>;

/** Minimum invocations the repo relies on beyond mise.toml (wasmtime tar extract, etc.). */
export const REQUIRED_COMMANDS = ["xz", "git", "curl", "ps", "docker"] as const;

export function evaluateCiRunnerContract(root: string): ContractCheck[] {
	const checks: ContractCheck[] = [];

	if (!existsSync(join(root, MISE_TOML))) {
		checks.push({
			ok: false,
			name: "mise.toml",
			detail: "missing repo-root mise.toml",
		});
		return checks;
	}
	if (!existsSync(join(root, MISE_LOCK))) {
		checks.push({
			ok: false,
			name: "mise.lock",
			detail: "missing repo-root mise.lock",
		});
		return checks;
	}

	const miseToml = readFileSync(join(root, MISE_TOML), "utf8");
	for (const tool of parseMiseToolNames(miseToml)) {
		const which = run("sh", ["-c", `command -v ${tool} || true`]);
		const path = which.out.split("\n")[0]?.trim() ?? "";
		if (!path) {
			checks.push({
				ok: false,
				name: `mise-tool:${tool}`,
				detail: `${tool} not on PATH; run ${CI_RUNNER_BUILD_SCRIPT} after mise.lock changes`,
			});
			continue;
		}
		const ver =
			tool === "cue"
				? run("cue", ["version"])
				: tool === "gitleaks"
					? run("gitleaks", ["version"])
					: run(tool, ["--version"]);
		checks.push({
			ok: ver.ok,
			name: `mise-tool:${tool}`,
			detail: ver.ok ? ver.out.split("\n")[0]! : ver.out,
		});
	}

	for (const cmd of REQUIRED_COMMANDS) {
		const which = run("sh", ["-c", `command -v ${cmd}`]);
		checks.push({
			ok: which.ok,
			name: `system:${cmd}`,
			detail: which.ok
				? which.out
				: `missing ${cmd} (install ${SYSTEM_COMMANDS[cmd as keyof typeof SYSTEM_COMMANDS] ?? cmd} via ${CI_RUNNER_SYSTEM_PACKAGES})`,
		});
	}

	const cue = run("cue", ["version"]);
	if (cue.ok && !cue.out.includes("0.14.0")) {
		checks.push({
			ok: false,
			name: "cue-version",
			detail: `expected cue 0.14.0, got: ${cue.out}`,
		});
	} else if (cue.ok) {
		checks.push({
			ok: true,
			name: "cue-version",
			detail: cue.out.split("\n")[0]!,
		});
	}

	if (
		process.env.HOBO_CI_RUNNER === "1" ||
		process.env.HOBO_CI_RUNNER_BASE === "1"
	) {
		const runner = run("sh", [
			"-c",
			"test -x /opt/actions-runner/run.sh && echo ok",
		]);
		checks.push({
			ok: runner.ok,
			name: "actions-runner",
			detail: runner.ok
				? "/opt/actions-runner/run.sh"
				: "missing preinstalled Actions runner in base image",
		});
	}

	return checks;
}

export function formatContractFailure(checks: ContractCheck[]): string {
	const failed = checks.filter((c) => !c.ok);
	const lines = failed.map((c) => `  - ${c.name}: ${c.detail}`);
	return [
		"CI runner image contract failed. Jobs must not run without required tools.",
		"Rebuild on the box worker (native arch, no cross-build):",
		`  bash ${CI_RUNNER_BUILD_SCRIPT}`,
		"See packages/ci/RUNNER-QUEUE.md",
		...lines,
	].join("\n");
}
