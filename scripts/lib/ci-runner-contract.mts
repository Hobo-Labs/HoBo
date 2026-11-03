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

/** Digest-pinned debian:bookworm-slim for the CI runner base layer (must match base/Dockerfile FROM). */
export const CI_RUNNER_DEBIAN_BOOKWORM_SLIM =
	"debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3";

export const CI_RUNNER_TURBO_AUBE_LOCK_DIR = ".mise/locks/turbo/2.11.10";

/**
 * Chromium headless shell baked into the base image. Revision and version must
 * match playwright-core's browsers.json, or Playwright looks for a directory the
 * image does not have; the digests are the release zips base/Dockerfile verifies.
 */
export const CI_RUNNER_PLAYWRIGHT_CHROMIUM = {
	browsersPath: "/opt/pw-browsers",
	revision: "1234",
	browserVersion: "151.0.7922.34",
	sha256: {
		amd64: "3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14",
		arm64: "b03443e1e1a60d06e07b6cdfe650b8c2bfcbb3db497d2b652f73dc6912f4ae15",
	},
} as const;

/** Executable inside the revision directory, per Playwright's linux-x64 / linux-arm64 layouts. */
export function playwrightHeadlessShellExecutables(
	browsersPath: string = CI_RUNNER_PLAYWRIGHT_CHROMIUM.browsersPath,
): readonly string[] {
	const dir = join(
		browsersPath,
		`chromium_headless_shell-${CI_RUNNER_PLAYWRIGHT_CHROMIUM.revision}`,
	);
	return [
		join(dir, "chrome-headless-shell-linux64", "chrome-headless-shell"),
		join(dir, "chrome-linux", "headless_shell"),
	];
}

const HEADLESS_SHELL_PROBE = "hobo-headless-shell-ok";

export const CI_RUNNER_PREFLIGHT_NODE_ARGS = [
	"--no-warnings",
	"scripts/ci-runner-preflight.mts",
] as const;

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

export function readBaseDockerfileFrom(root: string): string {
	return readFileSync(join(root, CI_RUNNER_BASE_DOCKERFILE), "utf8");
}

/** Ensures base/Dockerfile pins the canonical debian digest (single source of truth). */
export function assertBaseDockerfileDigestPinned(root: string): void {
	const dockerfile = readBaseDockerfileFrom(root);
	if (!dockerfile.includes(CI_RUNNER_DEBIAN_BOOKWORM_SLIM)) {
		throw new Error(
			`${CI_RUNNER_BASE_DOCKERFILE} must FROM ${CI_RUNNER_DEBIAN_BOOKWORM_SLIM}`,
		);
	}
}

export type DockerHubDigestRef = { repository: string; digest: string };

/** `debian:bookworm-slim@sha256:<hex>` → `{ repository: "library/debian", digest }`. */
export function parseDockerHubDigestRef(imageRef: string): DockerHubDigestRef {
	const match = imageRef.match(
		/^([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)?)(?::[\w][\w.-]*)?@(sha256:[a-f0-9]{64})$/,
	);
	if (!match)
		throw new Error(`not a digest-pinned Docker Hub ref: ${imageRef}`);
	const name = match[1]!;
	return {
		repository: name.includes("/") ? name : `library/${name}`,
		digest: match[2]!,
	};
}

// Index and manifest types alike. The Debian `docker.io` CLI in the runner
// image rejects an OCI index whose children are OCI manifests (attestations),
// so `docker manifest inspect` cannot be the check.
const MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Verifies Docker Hub serves the pinned base image digest (anonymous registry API). */
export async function verifyBaseImageDigestResolves(
	imageRef: string = CI_RUNNER_DEBIAN_BOOKWORM_SLIM,
	fetchImpl: typeof fetch = fetch,
): Promise<ContractCheck> {
	const fail = (detail: string): ContractCheck => ({
		ok: false,
		name: "base-image-digest",
		detail: `${imageRef}: ${detail}`,
	});
	const { repository, digest } = parseDockerHubDigestRef(imageRef);
	const tokenResponse = await fetchImpl(
		`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
	);
	if (!tokenResponse.ok)
		return fail(`registry token request returned ${tokenResponse.status}`);
	const token = (await tokenResponse.text()).match(
		/"token"\s*:\s*"([^"]+)"/,
	)?.[1];
	if (!token) return fail("registry token response carried no token");
	const manifest = await fetchImpl(
		`https://registry-1.docker.io/v2/${repository}/manifests/${digest}`,
		{
			method: "HEAD",
			headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
		},
	);
	if (!manifest.ok) return fail(`manifest request returned ${manifest.status}`);
	const served = manifest.headers.get("docker-content-digest");
	if (served !== digest)
		return fail(`registry served ${served ?? "no digest"}, expected ${digest}`);
	return { ok: true, name: "base-image-digest", detail: imageRef };
}

export function assertTurboLockSidecarsPresent(root: string): void {
	const lockText = readFileSync(join(root, MISE_LOCK), "utf8");
	const expectedDigest =
		"sha256:98a66ba91c04476d3edfbbe6d7153fae49b3c4b1d174805797db67030dd35af2";
	if (!lockText.includes(`digest = "${expectedDigest}"`)) {
		throw new Error(
			`${MISE_LOCK} turbo aube digest mismatch; run mise lock and commit ${CI_RUNNER_TURBO_AUBE_LOCK_DIR}`,
		);
	}
	for (const name of ["aube-lock.yaml", "package.json"]) {
		const path = join(root, CI_RUNNER_TURBO_AUBE_LOCK_DIR, name);
		if (!existsSync(path)) {
			throw new Error(`missing committed turbo lock sidecar: ${path}`);
		}
	}
}

export type ContractCheck = { ok: boolean; name: string; detail: string };

export type CommandResult = { ok: boolean; out: string };
export type CommandRunner = (cmd: string, args: string[]) => CommandResult;

function spawnCommand(cmd: string, args: string[]): CommandResult {
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
	skopeo: "skopeo",
} as const satisfies Record<string, string>;

/** Minimum invocations the repo relies on beyond mise.toml (wasmtime tar extract, etc.). */
export const REQUIRED_COMMANDS = ["xz", "git", "curl", "ps", "docker"] as const;

/**
 * Commands only the image build needs (build.sh loads the mise oci layout with skopeo).
 * Checked when the contract runs inside a freshly built candidate
 * (`HOBO_CI_RUNNER_CONTRACT=live`), so jobs on an older image are not refused for them.
 */
export const IMAGE_CONTRACT_COMMANDS = ["skopeo"] as const;

/**
 * Renders a page rather than asking for `--version`: the dynamic loader resolves
 * linked libraries for either, but only a render reaches the ones Chromium
 * opens at runtime. Live-only, so jobs on an image built before the browser was
 * baked in are not refused; the browser test names the missing path instead.
 */
function checkHeadlessShell(run: CommandRunner): ContractCheck {
	const candidates = playwrightHeadlessShellExecutables()
		.map((path) => `'${path}'`)
		.join(" ");
	const probe = run("sh", [
		"-c",
		`for exe in ${candidates}; do if [ -x "$exe" ]; then exec "$exe" --no-sandbox --disable-gpu --dump-dom 'data:text/html,<p>${HEADLESS_SHELL_PROBE}</p>'; fi; done; echo "no headless shell under ${CI_RUNNER_PLAYWRIGHT_CHROMIUM.browsersPath}" >&2; exit 1`,
	]);
	const ok = probe.ok && probe.out.includes(HEADLESS_SHELL_PROBE);
	return {
		ok,
		name: "playwright:chromium-headless-shell",
		detail: ok
			? `revision ${CI_RUNNER_PLAYWRIGHT_CHROMIUM.revision} renders`
			: `headless shell ${CI_RUNNER_PLAYWRIGHT_CHROMIUM.revision} did not render (install it via ${CI_RUNNER_BASE_DOCKERFILE}, libraries via ${CI_RUNNER_SYSTEM_PACKAGES}): ${probe.out.split("\n").slice(-3).join(" | ")}`,
	};
}

/** `run` defaults to spawning each probe; tests that only need check names pass a stub. */
export function evaluateCiRunnerContract(
	root: string,
	options: { readonly live?: boolean; readonly run?: CommandRunner } = {},
): ContractCheck[] {
	const live = options.live ?? process.env.HOBO_CI_RUNNER_CONTRACT === "live";
	const run = options.run ?? spawnCommand;
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

	const commands = live
		? [...REQUIRED_COMMANDS, ...IMAGE_CONTRACT_COMMANDS]
		: REQUIRED_COMMANDS;
	for (const cmd of commands) {
		const which = run("sh", ["-c", `command -v ${cmd}`]);
		const packageName = SYSTEM_COMMANDS[cmd];
		checks.push({
			ok: which.ok,
			name: `system:${cmd}`,
			detail: which.ok
				? which.out
				: `missing ${cmd} (install ${packageName} via ${CI_RUNNER_SYSTEM_PACKAGES})`,
		});
	}

	if (live) checks.push(checkHeadlessShell(run));

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
