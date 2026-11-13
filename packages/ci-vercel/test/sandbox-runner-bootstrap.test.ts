import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as archive from "../src/sandbox-runner-archive.js";
import {
	PREPARE_SANDBOX_RUNNER,
	prepareSandboxRunner,
	type SandboxRunnerBootstrapPort,
	START_SANDBOX_RUNNER,
	sandboxRunnerBootstrapPort,
	startSandboxRunner,
} from "../src/sandbox-runner-bootstrap.js";
import * as icu from "../src/sandbox-runner-icu.js";

describe("isolated runner bootstrap", () => {
	it("keeps JIT out of command metadata and launches only after validated input", async () => {
		const secret = "TESTONLY";
		const commands: unknown[] = [];
		const files: { path: string; content: Buffer; mode: number }[][] = [];
		type CommandOptions = { cmd: string; args: string[]; cwd: string };
		function runCommand(
			value: CommandOptions & { detached: true },
		): Promise<{ cmdId: string }>;
		function runCommand(
			value: CommandOptions & { detached: false },
		): Promise<{ exitCode: number }>;
		async function runCommand(value: CommandOptions & { detached: boolean }) {
			commands.push(value);
			return value.detached ? { cmdId: "command-1" } : { exitCode: 0 };
		}
		const sandbox: SandboxRunnerBootstrapPort = {
			writeFiles: async (value) => {
				files.push(value);
			},
			runCommand,
		};
		expect(await startSandboxRunner(sandbox, secret)).toEqual({
			cmdId: "command-1",
		});
		expect(files).toHaveLength(1);
		expect(files[0]?.[0]).toMatchObject({
			path: "/vercel/sandbox/.hobo-ci-jit",
			mode: 0o600,
			content: Buffer.from(secret),
		});
		expect(JSON.stringify(commands)).not.toContain(secret);
		expect(commands).toHaveLength(1);
		await expect(
			startSandboxRunner(sandbox, "invalid\ncommand"),
		).rejects.toThrow("invalid runner JIT configuration");
		expect(files).toHaveLength(1);
	});

	it("does not upload a forged runner archive to the VM", async () => {
		let writes = 0;
		const sandbox: SandboxRunnerBootstrapPort = {
			async writeFiles() {
				writes++;
			},
			async runCommand() {
				throw new Error("must not run");
			},
		};
		const fetcher: typeof fetch = async () => new Response("forged");
		await expect(prepareSandboxRunner(sandbox, fetcher)).rejects.toThrow(
			"checksum mismatch",
		);
		expect(writes).toBe(0);
	});

	it("does not upload either archive if the ICU package is forged", async () => {
		const download = vi
			.spyOn(archive, "downloadSandboxRunner")
			.mockResolvedValue(Buffer.from("verified runner"));
		let writes = 0;
		const sandbox: SandboxRunnerBootstrapPort = {
			async writeFiles() {
				writes++;
			},
			async runCommand() {
				throw new Error("must not run");
			},
		};
		try {
			await expect(
				prepareSandboxRunner(sandbox, async () => new Response("forged ICU")),
			).rejects.toThrow("checksum mismatch");
			expect(writes).toBe(0);
		} finally {
			download.mockRestore();
		}
	});

	it("checks the ICU checksum in the guest before running the installer", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-sandbox-icu-"));
		try {
			writeFileSync(join(root, "hobo-ci-icu.deb"), "forged ICU");
			const osRelease = join(root, "os-release");
			writeFileSync(osRelease, "ID=ubuntu\nVERSION_ID=26.04\n");
			const bin = join(root, "bin");
			mkdirSync(bin);
			writeFileSync(
				join(bin, "uname"),
				'#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo x86_64\n',
				{ mode: 0o755 },
			);
			writeFileSync(join(bin, "sudo"), "#!/bin/sh\ntouch installed-marker\n", {
				mode: 0o755,
			});
			const script = PREPARE_SANDBOX_RUNNER.replaceAll(
				"/vercel/sandbox",
				root,
			).replaceAll("/etc/os-release", osRelease);
			expect(() =>
				execFileSync("bash", ["-c", script], {
					env: { PATH: `${bin}:/usr/bin:/bin` },
					stdio: "pipe",
				}),
			).toThrow();
			expect(existsSync(join(root, "installed-marker"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not install the Ubuntu package on a different image", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-sandbox-image-"));
		try {
			const osRelease = join(root, "os-release");
			writeFileSync(osRelease, "ID=debian\nVERSION_ID=13\n");
			const bin = join(root, "bin");
			mkdirSync(bin);
			writeFileSync(
				join(bin, "uname"),
				'#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo x86_64\n',
				{ mode: 0o755 },
			);
			writeFileSync(join(bin, "sudo"), "#!/bin/sh\ntouch installed-marker\n", {
				mode: 0o755,
			});
			const script = PREPARE_SANDBOX_RUNNER.replaceAll(
				"/vercel/sandbox",
				root,
			).replaceAll("/etc/os-release", osRelease);
			expect(() =>
				execFileSync("bash", ["-c", script], {
					env: { PATH: `${bin}:/usr/bin:/bin` },
					stdio: "pipe",
				}),
			).toThrow();
			expect(existsSync(join(root, "installed-marker"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("creates the fresh VM workdir before uploading the verified runner", async () => {
		const download = vi
			.spyOn(archive, "downloadSandboxRunner")
			.mockResolvedValue(Buffer.from("verified archive"));
		const downloadIcu = vi
			.spyOn(icu, "downloadSandboxIcu")
			.mockResolvedValue(Buffer.from("verified ICU package"));
		const operations: string[] = [];
		const sandbox: SandboxRunnerBootstrapPort = {
			async writeFiles(files) {
				operations.push(`upload:${files[0]?.path}`);
			},
			async runCommand(command) {
				operations.push(`${command.cmd}:${command.cwd}`);
				return command.detached ? { cmdId: "unused" } : { exitCode: 0 };
			},
		};
		try {
			await prepareSandboxRunner(sandbox);
			expect(operations).toEqual([
				"mkdir:/",
				"upload:/vercel/sandbox/hobo-ci-runner.tar.gz",
				"bash:/vercel/sandbox",
			]);
		} finally {
			download.mockRestore();
			downloadIcu.mockRestore();
		}
	});

	it("does not extract a runner archive with a mismatched checksum", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-sandbox-prep-"));
		try {
			writeFileSync(join(root, "hobo-ci-runner.tar.gz"), "forged");
			const icuFile = join(root, "hobo-ci-icu.deb");
			writeFileSync(icuFile, "verified ICU fixture");
			const icuHash = createHash("sha256")
				.update(readFileSync(icuFile))
				.digest("hex");
			const osRelease = join(root, "os-release");
			writeFileSync(osRelease, "ID=ubuntu\nVERSION_ID=26.04\n");
			const bin = join(root, "bin");
			mkdirSync(bin);
			for (const [name, contents] of [
				[
					"uname",
					"#!/bin/sh\n[ \"$1\" = -s ] && printf 'Linux\\n' || printf 'x86_64\\n'\n",
				],
				["sudo", "#!/bin/sh\nexit 0\n"],
			] as const) {
				writeFileSync(join(bin, name), contents, { mode: 0o755 });
			}
			const script = PREPARE_SANDBOX_RUNNER.replaceAll("/vercel/sandbox", root)
				.replaceAll("/etc/os-release", osRelease)
				.replace(icu.SANDBOX_ICU_SHA256, icuHash);
			expect(() =>
				execFileSync("bash", ["-c", script], {
					env: { PATH: `${bin}:/usr/bin:/bin` },
					stdio: "pipe",
				}),
			).toThrow();
			expect(existsSync(join(root, ".hobo-ci-prepared"))).toBe(false);
			expect(existsSync(join(root, "hobo-ci-runner", "run.sh"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prepares an isolated writable home for the runner", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-sandbox-prep-"));
		try {
			const source = join(root, "source");
			mkdirSync(source);
			writeFileSync(join(source, "run.sh"), "#!/bin/sh\n");
			chmodSync(join(source, "run.sh"), 0o755);
			const file = join(root, "hobo-ci-runner.tar.gz");
			execFileSync("tar", ["-czf", file, "-C", source, "run.sh"]);
			const hash = createHash("sha256")
				.update(readFileSync(file))
				.digest("hex");
			const icuFile = join(root, "hobo-ci-icu.deb");
			writeFileSync(icuFile, "verified ICU fixture");
			const icuHash = createHash("sha256")
				.update(readFileSync(icuFile))
				.digest("hex");
			const osRelease = join(root, "os-release");
			writeFileSync(osRelease, "ID=ubuntu\nVERSION_ID=26.04\n");
			const script = PREPARE_SANDBOX_RUNNER.replaceAll("/vercel/sandbox", root)
				.replaceAll("/etc/os-release", osRelease)
				.replace(archive.SANDBOX_RUNNER_SHA256, hash)
				.replace(icu.SANDBOX_ICU_SHA256, icuHash);
			const bin = join(root, "bin");
			mkdirSync(bin);
			const uname = join(bin, "uname");
			writeFileSync(
				uname,
				"#!/bin/sh\n[ \"$1\" = -s ] && printf 'Linux\\n' || printf 'x86_64\\n'\n",
			);
			chmodSync(uname, 0o755);
			const sudo = join(bin, "sudo");
			writeFileSync(
				sudo,
				'#!/bin/sh\n[ "$1" = -n ] && [ "$2" = env ] && [ "$3" = DEBIAN_FRONTEND=noninteractive ] && [ "$4" = dpkg ] && [ "$5" = -i ] && [ "$6" = hobo-ci-icu.deb ] && [ -f "$6" ]\n',
			);
			chmodSync(sudo, 0o755);
			execFileSync("bash", ["-c", script], {
				env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
				stdio: "pipe",
			});
			expect(existsSync(join(root, ".hobo-ci-prepared"))).toBe(true);
			expect(existsSync(file)).toBe(false);
			expect(existsSync(icuFile)).toBe(false);
			expect(statSync(join(root, ".hobo-ci-home")).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("unlinks the JIT file, strips inherited credentials, and refuses a second start", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-sandbox-start-"));
		try {
			const runner = join(root, "hobo-ci-runner");
			mkdirSync(runner);
			mkdirSync(join(root, ".hobo-ci-home"));
			const caBundle = join(root, "ca-bundle.pem");
			writeFileSync(caBundle, "fixture certificate bundle");
			writeFileSync(join(root, ".hobo-ci-prepared"), "");
			writeFileSync(join(root, ".hobo-ci-jit"), "unit test JIT fixture", {
				mode: 0o600,
			});
			const scriptPath = join(runner, "run.sh");
			writeFileSync(
				scriptPath,
				`#!/bin/sh
[ "$1" = --jitconfig ] && [ "$2" = "unit test JIT fixture" ] && [ -z "\${HOST_CREDENTIAL+x}" ] && [ "$USER" = "$(id -un)" ] && [ -d "$HOME" ] && [ -w "$HOME" ] || exit 42
[ "$NODE_USE_SYSTEM_CA" = 1 ] && [ "$NODE_EXTRA_CA_CERTS" = "${caBundle}" ] && [ "$AWS_CA_BUNDLE" = "$NODE_EXTRA_CA_CERTS" ] && [ "$CARGO_HTTP_CAINFO" = "$NODE_EXTRA_CA_CERTS" ] && [ "$CURL_CA_BUNDLE" = "$NODE_EXTRA_CA_CERTS" ] && [ "$GIT_SSL_CAINFO" = "$NODE_EXTRA_CA_CERTS" ] && [ "$GRPC_DEFAULT_SSL_ROOTS_FILE_PATH" = "$NODE_EXTRA_CA_CERTS" ] && [ "$NPM_CONFIG_CAFILE" = "$NODE_EXTRA_CA_CERTS" ] && [ "$PIP_CERT" = "$NODE_EXTRA_CA_CERTS" ] && [ "$REQUESTS_CA_BUNDLE" = "$NODE_EXTRA_CA_CERTS" ] && [ "$SSL_CERT_FILE" = "$NODE_EXTRA_CA_CERTS" ] && [ -z "\${NODE_TLS_REJECT_UNAUTHORIZED+x}" ] || exit 43
printf 'run\\n' >> ../runs
printf 'home\\n' > "$HOME/probe"
`,
			);
			chmodSync(scriptPath, 0o755);
			const script = START_SANDBOX_RUNNER.replaceAll(
				"/vercel/sandbox",
				root,
			).replaceAll("/etc/ssl/certs/ca-certificates.crt", caBundle);
			execFileSync("bash", ["-c", script], {
				env: {
					...process.env,
					HOST_CREDENTIAL: "must-not-reach-runner",
					NODE_EXTRA_CA_CERTS: "/host/untrusted.pem",
					NODE_TLS_REJECT_UNAUTHORIZED: "0",
				},
				stdio: "pipe",
			});
			expect(existsSync(join(root, ".hobo-ci-jit"))).toBe(false);
			expect(readFileSync(join(root, ".hobo-ci-home", "probe"), "utf8")).toBe(
				"home\n",
			);
			writeFileSync(join(root, ".hobo-ci-jit"), "unit test JIT fixture", {
				mode: 0o600,
			});
			expect(() =>
				execFileSync("bash", ["-c", script], { stdio: "pipe" }),
			).toThrow();
			expect(readFileSync(join(root, "runs"), "utf8")).toBe("run\n");
			expect(existsSync(join(root, ".hobo-ci-jit"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to start when the trusted CA bundle is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-sandbox-no-ca-"));
		try {
			mkdirSync(join(root, "hobo-ci-runner"));
			mkdirSync(join(root, ".hobo-ci-home"));
			writeFileSync(join(root, ".hobo-ci-prepared"), "");
			writeFileSync(join(root, ".hobo-ci-jit"), "unit test JIT fixture");
			const script = START_SANDBOX_RUNNER.replaceAll(
				"/vercel/sandbox",
				root,
			).replaceAll(
				"/etc/ssl/certs/ca-certificates.crt",
				join(root, "missing.pem"),
			);
			expect(() =>
				execFileSync("bash", ["-c", script], { stdio: "pipe" }),
			).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("the bootstrap port", () => {
	it("is the specific Session itself, never a Sandbox handle that could resume", () => {
		const session = { sessionId: "sbx_1" };
		// SAFETY: the port only hands the Session back; no member of it is read.
		const port = sandboxRunnerBootstrapPort(session as never);
		expect(port).toBe(session);
	});
});
