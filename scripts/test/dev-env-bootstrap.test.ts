/**
 * Dev environment bootstrap contract: mise.toml, bootstrap script, and optional Docker smoke.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./support/pins-support.ts";

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("dev-env bootstrap", () => {
	it("commits mise.toml and lockfile with matching tool names", () => {
		const toml = read("mise.toml");
		const lock = read("mise.lock");
		for (const tool of ["node", "pnpm", "cue", "turbo"]) {
			assert.match(toml, new RegExp(`${tool}\\s*=`, "u"));
			assert.match(lock, new RegExp(`\\[\\[tools\\.${tool}\\]\\]`, "u"));
		}
	});

	it("bootstrap-dev isolates installation and reuses each selected executable", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-bootstrap-"));
		const tools = join(dir, "tools");
		const home = join(dir, "home");
		const installer = join(dir, "installer.sh");
		mkdirSync(tools);
		mkdirSync(home);
		for (const name of ["bash", "sh", "dirname", "mkdir", "cat", "chmod"]) {
			const command = [`/usr/bin/${name}`, `/bin/${name}`].find(existsSync);
			assert.ok(command, `missing test command: ${name}`);
			writeFileSync(join(tools, name), `#!/bin/sh\nexec "${command}" "$@"\n`, {
				mode: 0o755,
			});
		}
		writeFileSync(
			join(tools, "curl"),
			'#!/bin/sh\ncat "$HOBO_MISE_TEST_INSTALLER"\n',
			{ mode: 0o755 },
		);
		writeFileSync(
			installer,
			[
				'printf "installed\\n" >> "$HOBO_MISE_TEST_INSTALLS"',
				'target="${MISE_INSTALL_PATH:-$HOME/.local/bin/mise}"',
				'mkdir -p "$(dirname "$target")"',
				"cat > \"$target\" <<'FAKE_MISE'",
				"#!/bin/sh",
				'printf "%s\\n" "$*" >> "$HOBO_MISE_TEST_LOG"',
				"FAKE_MISE",
				'chmod +x "$target"',
				"",
			].join("\n"),
		);
		try {
			for (const name of ["default", "mise", "custom-mise"]) {
				const log = join(dir, `${name}.log`);
				const installs = join(dir, `${name}.installs`);
				if (name !== "default") {
					writeFileSync(join(tools, "mise"), "#!/bin/sh\nexit 97\n", {
						mode: 0o755,
					});
				}
				const env: NodeJS.ProcessEnv = {
					PATH: tools,
					HOME: home,
					HOBO_SKIP_DOTFILES: "1",
					MISE_INSTALL_URL: "https://unused.invalid/mise",
					HOBO_MISE_TEST_INSTALLER: installer,
					HOBO_MISE_TEST_LOG: log,
					HOBO_MISE_TEST_INSTALLS: installs,
				};
				if (name !== "default") env.MISE_INSTALL_PATH = join(dir, name, name);
				for (let attempt = 0; attempt < 2; attempt++) {
					const result = spawnSync(
						"bash",
						["scripts/bootstrap-dev.sh", "--project-only"],
						{
							cwd: REPO_ROOT,
							encoding: "utf8",
							env,
						},
					);
					assert.equal(
						result.status,
						0,
						`${name}: bootstrap-dev failed:\n${result.stderr}\n${result.stdout}`,
					);
					assert.match(result.stdout, /bootstrap-dev: done/u);
				}
				assert.equal(readFileSync(installs, "utf8"), "installed\n");
				assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
					`trust ${join(REPO_ROOT, "mise.toml")}`,
					"install",
					"activate bash",
					`trust ${join(REPO_ROOT, "mise.toml")}`,
					"install",
					"activate bash",
				]);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a relative override before starting an installer", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-relative-installer-"));
		try {
			const installer = join(dir, "installer.sh");
			writeFileSync(installer, "exit 0\n");
			for (const fn of ["mise_ensure_on_path", "mise_ensure_installed"]) {
				const result = spawnSync(
					"bash",
					["-c", `source scripts/lib/mise-path.sh && ${fn}`],
					{
						cwd: REPO_ROOT,
						encoding: "utf8",
						env: {
							PATH: "/usr/bin:/bin",
							HOME: dir,
							MISE_INSTALL_PATH: "relative/mise",
							MISE_INSTALL_URL: pathToFileURL(installer).href,
							MISE_INSTALL_ATTEMPTS: "1",
						},
					},
				);
				assert.notEqual(result.status, 0);
				assert.match(result.stderr, /install path must be absolute/u);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("finds an existing override when PATH is empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-existing-mise-"));
		try {
			const mise = join(dir, "custom-mise");
			writeFileSync(mise, '#!/bin/sh\nprintf "%s\\n" "$*"\n', {
				mode: 0o755,
			});
			const result = spawnSync(
				"/bin/bash",
				[
					"-c",
					'source scripts/lib/mise-path.sh && mise_ensure_on_path && printf "%s\\n" "$PATH" && hobo_mise ready',
				],
				{
					cwd: REPO_ROOT,
					encoding: "utf8",
					env: { PATH: "", HOME: dir, MISE_INSTALL_PATH: mise },
				},
			);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout, `${dir}\nready\n`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a successful installer that did not create the selected executable", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-empty-installer-"));
		try {
			const installer = join(dir, "installer.sh");
			writeFileSync(installer, "exit 0\n");
			const result = spawnSync(
				"bash",
				["-c", "source scripts/lib/mise-path.sh && mise_ensure_on_path"],
				{
					cwd: REPO_ROOT,
					encoding: "utf8",
					env: {
						PATH: "/usr/bin:/bin",
						HOME: dir,
						MISE_INSTALL_PATH: dir,
						MISE_INSTALL_URL: pathToFileURL(installer).href,
						MISE_INSTALL_ATTEMPTS: "1",
					},
				},
			);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /installer did not create an executable/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("propagates an installer failure even when it leaves an executable", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-failed-installer-"));
		try {
			const installer = join(dir, "installer.sh");
			writeFileSync(
				installer,
				'printf "#!/bin/sh\\nexit 0\\n" > "$MISE_INSTALL_PATH"\nchmod +x "$MISE_INSTALL_PATH"\nexit 1\n',
			);
			const result = spawnSync(
				"bash",
				[
					"-c",
					"source scripts/lib/mise-path.sh; if mise_ensure_on_path; then exit 0; else exit 8; fi",
				],
				{
					cwd: REPO_ROOT,
					encoding: "utf8",
					env: {
						PATH: "/usr/bin:/bin",
						HOME: dir,
						MISE_INSTALL_PATH: join(dir, "mise"),
						MISE_INSTALL_URL: pathToFileURL(installer).href,
						MISE_INSTALL_ATTEMPTS: "1",
					},
				},
			);
			assert.equal(result.status, 8, result.stderr);
			assert.match(result.stderr, /install failed after 1 attempts/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("documents bootstrap in AGENTS.md and CLAUDE.md", () => {
		for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
			const text = read(doc);
			assert.match(
				text,
				/bootstrap-dev\.sh/u,
				`${doc} mentions bootstrap-dev.sh`,
			);
			assert.match(text, /mise/u, `${doc} mentions mise`);
		}
	});
});
