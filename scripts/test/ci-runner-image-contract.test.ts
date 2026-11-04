import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertBaseDockerfileDigestPinned,
	assertTurboLockSidecarsPresent,
	CI_RUNNER_BASE_DOCKERFILE,
	CI_RUNNER_BUILD_SCRIPT,
	CI_RUNNER_PLAYWRIGHT_CHROMIUM,
	CI_RUNNER_PREFLIGHT_NODE_ARGS,
	CI_RUNNER_SYSTEM_PACKAGES,
	type CommandRunner,
	ciRunnerImageVersion,
	evaluateCiRunnerContract,
	IMAGE_CONTRACT_COMMANDS,
	MISE_LOCK,
	MISE_TOML,
	parseDockerHubDigestRef,
	playwrightHeadlessShellExecutables,
	probeMiseTool,
	REQUIRED_COMMANDS,
	spawnCommand,
	syncMissingMiseTools,
	verifyBaseImageDigestResolves,
} from "../lib/ci-runner-contract.mts";

const root = join(import.meta.dirname, "..", "..");

// Check names do not depend on what the host has installed, so these cases
// skip the dozen sequential tool spawns a stalled runner box can stretch past
// the test timeout. The preflight case below still runs the real probes.
const present: CommandRunner = () => ({
	ok: true,
	out: "/usr/bin/stub 0.14.0",
});

describe("ci-runner tool command diagnostics", () => {
	const probeWith = (result: ReturnType<typeof spawnCommand>) =>
		probeMiseTool("shellcheck", (cmd, args) =>
			cmd === "sh" ? present(cmd, args) : result,
		);

	it("reports ENOENT, the attempted command, and the remedy", () => {
		const missing = `hobo-shellcheck-not-installed-${process.pid}`;
		const check = probeWith(spawnCommand(missing, ["--version"]));
		expect(check.ok).toBe(false);
		expect(check.name).toBe("mise-tool:shellcheck");
		expect(check.detail).toContain(`${missing} --version`);
		expect(check.detail).toContain("spawn error ENOENT");
		expect(check.detail).toContain("not installed in runner image");
		expect(check.detail).toContain("Remedy: preflight installs missing tools");
		expect(check.detail).toContain("mise install --locked");
	});

	it("reports a terminating signal instead of a null exit", () => {
		const check = probeWith(spawnCommand("sh", ["-c", "kill -TERM $$"]));
		expect(check.ok).toBe(false);
		expect(check.detail).toContain("sh -c 'kill -TERM $$'");
		expect(check.detail).toContain("terminated by signal SIGTERM");
		expect(check.detail).toContain("no exit status");
		expect(check.detail).not.toContain("exit null");
	});

	it("reports a non-zero exit and only the stderr tail", () => {
		const check = probeWith(
			spawnCommand("sh", [
				"-c",
				"printf 'first\\nsecond\\nthird\\nfourth\\n' >&2; exit 7",
			]),
		);
		expect(check.ok).toBe(false);
		expect(check.detail).toContain("exited 7");
		expect(check.detail).toContain("stderr tail: second | third | fourth");
		expect(check.detail).not.toContain("stderr tail: first");
	});
});

describe("ci-runner mise tool sync", () => {
	it("installs only missing checkout tools with the lockfile and reports elapsed time", () => {
		const calls: { cmd: string; args: string[] }[] = [];
		const times = [100, 175];
		const result = syncMissingMiseTools(root, {
			run: (cmd, args) => {
				calls.push({ cmd, args });
				return {
					ok: true,
					out: args.includes("ls")
						? "shellcheck 0.10.0 (missing) /checkout/mise.toml 0.10.0\nnot-in-mise-toml 1 (missing)"
						: "",
				};
			},
			now: () => times.shift() ?? 175,
		});
		expect(result.ok).toBe(true);
		expect(result.installed).toEqual(["shellcheck"]);
		expect(result.elapsedMs).toBe(75);
		expect(result.detail).toContain("installed shellcheck");
		expect(calls).toEqual([
			{ cmd: "mise", args: ["--cd", root, "trust", "./mise.toml"] },
			{
				cmd: "mise",
				args: ["--cd", root, "ls", "--current", "--missing", "--no-header"],
			},
			{
				cmd: "mise",
				args: ["--cd", root, "install", "--locked", "shellcheck"],
			},
		]);
	});

	it("does not invoke the installer when no checkout tool is missing", () => {
		const calls: string[][] = [];
		const result = syncMissingMiseTools(root, {
			run: (_cmd, args) => {
				calls.push(args);
				return { ok: true, out: "" };
			},
		});
		expect(result.ok).toBe(true);
		expect(result.installed).toEqual([]);
		expect(calls.some((args) => args.includes("install"))).toBe(false);
	});
});

describe("ci-runner image contract (repo manifests)", () => {
	it("pins mise.toml and mise.lock at repo root", () => {
		expect(existsSync(join(root, MISE_TOML))).toBe(true);
		expect(existsSync(join(root, MISE_LOCK))).toBe(true);
		const toml = readFileSync(join(root, MISE_TOML), "utf8");
		expect(toml).toContain("[oci]");
		expect(toml).toContain('user = "1000:1000"');
		expect(toml).toContain("gitleaks");
		expect(toml).toContain("127.0.0.1:5000");
	});

	it("locks every toolchain entry on every supported platform", () => {
		const toml = readFileSync(join(root, MISE_TOML), "utf8");
		const lock = readFileSync(join(root, MISE_LOCK), "utf8");
		const toolsSection = toml.split("[tools]")[1]?.split("\n[")[0] ?? "";
		const tools = [...toolsSection.matchAll(/^([\w-]+)\s*=/gm)].map(
			(match) => match[1],
		);
		expect(tools).toEqual([
			"cue",
			"gitleaks",
			"node",
			"pnpm",
			"shellcheck",
			"turbo",
		]);
		const platforms = [
			...new Set(
				[...lock.matchAll(/^\[tools\.[\w-]+\."platforms\.([^"]+)"\]$/gm)].map(
					(match) => match[1],
				),
			),
		];
		expect(platforms).toEqual([
			"linux-arm64",
			"linux-arm64-musl",
			"linux-x64",
			"linux-x64-musl",
			"macos-arm64",
			"macos-x64",
			"windows-x64",
		]);
		for (const tool of tools) {
			const toolEntry = lock.split(`[[tools.${tool}]]`)[1]?.split("\n[")[0];
			expect(toolEntry, `${tool} lock entry`).toBeDefined();
			if (toolEntry?.includes("aube =")) {
				expect(toolEntry).toContain('digest = "sha256:');
				continue;
			}
			for (const platform of platforms) {
				const entry = lock
					.split(`[tools.${tool}."platforms.${platform}"]`)[1]
					?.split("\n[")[0];
				expect(entry, `${tool} on ${platform}`).toContain("checksum = ");
				expect(entry, `${tool} on ${platform}`).toContain("url = ");
			}
		}
	});

	it("declares system packages, base Dockerfile, and oci build script", () => {
		expect(existsSync(join(root, CI_RUNNER_BASE_DOCKERFILE))).toBe(true);
		expect(existsSync(join(root, CI_RUNNER_SYSTEM_PACKAGES))).toBe(true);
		expect(existsSync(join(root, CI_RUNNER_BUILD_SCRIPT))).toBe(true);
		const pkgList = readFileSync(join(root, CI_RUNNER_SYSTEM_PACKAGES), "utf8");
		for (const cmd of REQUIRED_COMMANDS) {
			if (cmd === "ps") expect(pkgList).toMatch(/procps/);
			if (cmd === "xz") expect(pkgList).toMatch(/xz-utils/);
			if (cmd === "docker") expect(pkgList).toMatch(/docker\.io/);
		}
		const packages = new Set(
			pkgList
				.split("\n")
				.map((line) => line.replace(/#.*/, "").trim())
				.filter(Boolean),
		);
		for (const cmd of IMAGE_CONTRACT_COMMANDS) {
			expect(packages.has(cmd), `${cmd} in system-packages.txt`).toBe(true);
		}
	});

	it("installs every tool from mise.lock in both runner image build paths", () => {
		const build = readFileSync(join(root, CI_RUNNER_BUILD_SCRIPT), "utf8");
		expect(build).toContain("mise install --locked\n");
		expect(build).toContain("mise --locked oci build ");
		const fallback = readFileSync(
			join(
				root,
				"packages/ci-gh-actions/deploy/ci-runner/Dockerfile.monolithic",
			),
			"utf8",
		);
		expect(fallback).toContain("mise install --locked");
		for (const tool of [
			"node --version",
			"pnpm --version",
			"cue version",
			"gitleaks version",
			"shellcheck --version",
			"turbo --version",
		]) {
			expect(fallback).toContain(`mise exec -- ${tool}`);
		}
	});

	it("checks the image-build commands only inside a built candidate", () => {
		const names = (live: boolean) =>
			new Set(
				evaluateCiRunnerContract(root, { live, run: present }).map(
					(c) => c.name,
				),
			);
		for (const cmd of IMAGE_CONTRACT_COMMANDS) {
			expect(names(true).has(`system:${cmd}`)).toBe(true);
			expect(names(false).has(`system:${cmd}`)).toBe(false);
		}
	});

	it("bakes in the headless shell revision the installed Playwright resolves", () => {
		const require = createRequire(join(root, "package.json"));
		const playwrightCore = createRequire(require.resolve("playwright")).resolve(
			"playwright-core/package.json",
		);
		const manifest: {
			browsers: { name: string; revision: string; browserVersion: string }[];
		} = JSON.parse(
			readFileSync(join(dirname(playwrightCore), "browsers.json"), "utf8"),
		);
		const shell = manifest.browsers.find(
			(b) => b.name === "chromium-headless-shell",
		);
		expect(shell?.revision).toBe(CI_RUNNER_PLAYWRIGHT_CHROMIUM.revision);
		expect(shell?.browserVersion).toBe(
			CI_RUNNER_PLAYWRIGHT_CHROMIUM.browserVersion,
		);

		const dockerfile = readFileSync(
			join(root, CI_RUNNER_BASE_DOCKERFILE),
			"utf8",
		);
		const pins = CI_RUNNER_PLAYWRIGHT_CHROMIUM;
		expect(dockerfile).toContain(
			`ARG PLAYWRIGHT_CHROMIUM_REVISION=${pins.revision}\n`,
		);
		expect(dockerfile).toContain(
			`ARG PLAYWRIGHT_CHROMIUM_VERSION=${pins.browserVersion}\n`,
		);
		expect(dockerfile).toContain(
			`ARG PLAYWRIGHT_HEADLESS_SHELL_SHA256_X64=${pins.sha256.amd64}\n`,
		);
		expect(dockerfile).toContain(
			`ARG PLAYWRIGHT_HEADLESS_SHELL_SHA256_ARM64=${pins.sha256.arm64}\n`,
		);
		expect(dockerfile).toContain(
			`ENV PLAYWRIGHT_BROWSERS_PATH=${pins.browsersPath}\n`,
		);

		const packages = readFileSync(join(root, CI_RUNNER_SYSTEM_PACKAGES), "utf8")
			.split("\n")
			.map((line) => line.replace(/#.*/, "").trim());
		for (const pkg of ["unzip", "libnss3", "libgbm1", "libasound2"]) {
			expect(packages, `${pkg} in system-packages.txt`).toContain(pkg);
		}
	});

	it("probes the headless shell by rendering, only inside a built candidate", () => {
		const probe =
			(out: string): CommandRunner =>
			(cmd, args) =>
				cmd === "sh" && args[1]?.includes("--dump-dom")
					? { ok: true, out }
					: { ok: true, out: "/usr/bin/stub 0.14.0" };
		const shellCheck = (live: boolean, out: string) =>
			evaluateCiRunnerContract(root, { live, run: probe(out) }).find(
				(c) => c.name === "playwright:chromium-headless-shell",
			);
		expect(shellCheck(false, "")).toBeUndefined();
		expect(
			shellCheck(
				true,
				"<html><body><p>hobo-headless-shell-ok</p></body></html>",
			)?.ok,
		).toBe(true);
		expect(shellCheck(true, "error while loading shared libraries")?.ok).toBe(
			false,
		);
		const [x64, arm64] = playwrightHeadlessShellExecutables("/b");
		expect(x64).toBe(
			"/b/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell",
		);
		expect(arm64).toBe(
			"/b/chromium_headless_shell-1234/chrome-linux/headless_shell",
		);
	});

	it("pins a resolvable debian:bookworm-slim digest in the base Dockerfile", async () => {
		expect(() => assertBaseDockerfileDigestPinned(root)).not.toThrow();
		if (process.env.HOBO_CI_VERIFY_BASE_DIGEST === "1") {
			const check = await verifyBaseImageDigestResolves();
			expect(check.ok, check.detail).toBe(true);
		}
	});

	it("commits turbo lock sidecars referenced by mise.lock", () => {
		expect(() => assertTurboLockSidecarsPresent(root)).not.toThrow();
	});

	it("derives a stable image version tag from lock + base inputs", () => {
		const v = ciRunnerImageVersion(root);
		expect(v).toMatch(/^v[0-9a-f]{12}$/);
	});

	it("moves the image version when any build input changes, build.sh included", () => {
		const inputs = [
			MISE_LOCK,
			MISE_TOML,
			CI_RUNNER_SYSTEM_PACKAGES,
			CI_RUNNER_BASE_DOCKERFILE,
			CI_RUNNER_BUILD_SCRIPT,
		];
		const copy = mkdtempSync(join(tmpdir(), "ci-runner-version-"));
		try {
			for (const rel of inputs) {
				mkdirSync(dirname(join(copy, rel)), { recursive: true });
				copyFileSync(join(root, rel), join(copy, rel));
			}
			const base = ciRunnerImageVersion(copy);
			expect(base).toBe(ciRunnerImageVersion(root));
			for (const rel of inputs) {
				const original = readFileSync(join(copy, rel));
				appendFileSync(join(copy, rel), "\n");
				expect(ciRunnerImageVersion(copy), rel).not.toBe(base);
				writeFileSync(join(copy, rel), original);
			}
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	});

	it("evaluates live toolchain contract when running inside the runner image", () => {
		if (process.env.HOBO_CI_RUNNER_CONTRACT !== "live") {
			return;
		}
		const checks = evaluateCiRunnerContract(root);
		const failed = checks.filter((c) => !c.ok);
		expect(failed, failed.map((f) => f.detail).join("; ")).toEqual([]);
	});
});

describe("ci-runner image contract (host smoke)", () => {
	it("documents required commands in system manifest", () => {
		const checks = evaluateCiRunnerContract(root, { run: present });
		const names = new Set(checks.map((c) => c.name));
		for (const cmd of REQUIRED_COMMANDS) {
			expect(names.has(`system:${cmd}`)).toBe(true);
		}
	});

	it("preflight composite action does not depend on tsx", () => {
		const action = readFileSync(
			join(root, ".github/actions/ci-runner-preflight/action.yml"),
			"utf8",
		);
		expect(action).toContain(
			"node --no-warnings scripts/ci-runner-preflight.mts",
		);
		expect(action).not.toContain("tsx");
	});

	it("preflight runs with Node native TS only (no node_modules / tsx)", () => {
		const result = spawnSync(process.execPath, CI_RUNNER_PREFLIGHT_NODE_ARGS, {
			cwd: root,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				USER: process.env.USER ?? "",
				LANG: process.env.LANG ?? "C.UTF-8",
			},
			encoding: "utf8",
		});
		const combined = `${result.stdout}\n${result.stderr}`;
		expect(combined).not.toMatch(/ERR_MODULE_NOT_FOUND.*['"]tsx['"]/);
		expect(combined).not.toContain("--import tsx");
	});

	it("image version script runs without tsx", () => {
		const result = spawnSync(
			process.execPath,
			["--no-warnings", "scripts/ci-runner-image-version.mts"],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					USER: process.env.USER ?? "",
					LANG: process.env.LANG ?? "C.UTF-8",
				},
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toMatch(/^v[0-9a-f]{12}$/);
		expect(`${result.stdout}${result.stderr}`).not.toContain("tsx");
	});
});

describe("ci-runner base digest check (registry API)", () => {
	const digest = `sha256:${"a".repeat(64)}`;
	const ref = `debian:bookworm-slim@${digest}`;
	const registry = (served: string | null, status = 200) => {
		const calls: { url: string; init: RequestInit | undefined }[] = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.startsWith("https://auth.docker.io/"))
				return new Response(JSON.stringify({ token: "synthetic-token" }));
			const headers = new Headers();
			if (served) headers.set("docker-content-digest", served);
			return new Response(null, { status, headers });
		};
		return { calls, fetchImpl };
	};

	it("maps official images to library/ and keeps the digest", () => {
		expect(parseDockerHubDigestRef(ref)).toEqual({
			repository: "library/debian",
			digest,
		});
		expect(parseDockerHubDigestRef(`org/img@${digest}`).repository).toBe(
			"org/img",
		);
		expect(() => parseDockerHubDigestRef("debian:bookworm-slim")).toThrow();
	});

	it("accepts an OCI index and passes when the registry serves the pinned digest", async () => {
		const { calls, fetchImpl } = registry(digest);
		const check = await verifyBaseImageDigestResolves(ref, fetchImpl);
		expect(check.ok, check.detail).toBe(true);
		const manifest = calls[1];
		expect(manifest?.url).toBe(
			`https://registry-1.docker.io/v2/library/debian/manifests/${digest}`,
		);
		const headers = new Headers(manifest?.init?.headers);
		expect(headers.get("accept")).toContain(
			"application/vnd.oci.image.index.v1+json",
		);
		expect(headers.get("authorization")).toBe("Bearer synthetic-token");
	});

	it("fails when the registry serves another digest or no manifest", async () => {
		const other = await verifyBaseImageDigestResolves(
			ref,
			registry(`sha256:${"b".repeat(64)}`).fetchImpl,
		);
		expect(other.ok).toBe(false);
		expect(other.detail).toContain("expected");
		const missing = await verifyBaseImageDigestResolves(
			ref,
			registry(null, 404).fetchImpl,
		);
		expect(missing.ok).toBe(false);
		expect(missing.detail).toContain("404");
	});
});
