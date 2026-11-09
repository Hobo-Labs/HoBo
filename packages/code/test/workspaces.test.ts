/**
 * Workspace resolution and per-agent trees.
 *
 * Panes used to open in `process.cwd()` — wherever the shell happened to be —
 * and the "rift backend" created an empty directory holding a JSON marker, so
 * an agent opening it found nothing at all. These pin the replacements.
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { first, must } from "@hobo/core/total-access";
import { afterAll, describe, expect, it } from "vitest";
import {
	allocateAgentWorkspaces,
	findGitRoot,
} from "../src/agent-workspaces.js";
import {
	applySettingsToSeatCommand,
	defaultHarnessSettings,
} from "../src/harness-settings.js";
import { placedCommand } from "../src/mux.js";
import {
	createRiftWorkspace,
	parseCreatedPath,
	probeRift,
	type RiftRunner,
	resolveRiftBinary,
	speaksContract,
} from "../src/rift.js";
import { findWorkspaceRoot } from "../src/workspace.js";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
/** A PATH containing a stand-in `rift`, so capability probing is exercised. */
function fakeRiftBin(name = "rift"): string {
	const bin = tmp();
	writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
	return bin;
}

function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "ws-test-"));
	dirs.push(d);
	return d;
}

describe("workspace root", () => {
	it("prefers an active devenv shell", () => {
		const root = tmp();
		expect(
			findWorkspaceRoot("/anywhere", { DEVENV_ROOT: root }, () => true).source,
		).toBe("DEVENV_ROOT");
	});

	it("finds the nearest ancestor declaring devenv", () => {
		const root = tmp();
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(root, "devenv.nix"), "{}");
		const found = findWorkspaceRoot(nested, {});
		expect(found.path).toBe(root);
		expect(found.source).toBe("devenv-config");
	});

	it("falls back to the git root, then cwd", () => {
		// Injected existence: /tmp/.git exists on some machines, which would
		// otherwise make "no repo anywhere" untestable.
		const onlyRepo = (p: string) => p === "/repo/.git";
		expect(findWorkspaceRoot("/repo/pkg", {}, onlyRepo)).toEqual({
			path: "/repo",
			source: "git-root",
		});
		expect(findWorkspaceRoot("/bare/dir", {}, () => false)).toEqual({
			path: "/bare/dir",
			source: "cwd",
		});
	});
});

describe("rift capability", () => {
	it("reads the created workspace path from stdout", () => {
		expect(parseCreatedPath("noise\n/tmp/rifts/parser-fix\n")).toBe(
			"/tmp/rifts/parser-fix",
		);
		expect(parseCreatedPath("no path here")).toBeNull();
	});

	it("refuses to claim rift when the platform ships no binary", async () => {
		// The npm package installs happily without a binary for your platform;
		// presence on PATH is not capability.
		const runner: RiftRunner = {
			run: async () => ({
				code: 1,
				stdout: "",
				stderr: "Unable to locate the Rift binary for linux-arm64.",
			}),
		};
		const cap = await probeRift(
			"/ws",
			runner,
			{ PATH: fakeRiftBin() },
			() => null,
		);
		expect(cap.usable).toBe(false);
		expect(cap.reason).toMatch(/no binary for this platform/);
	});

	it("reports plainly when rift is not installed", async () => {
		const cap = await probeRift(
			"/ws",
			{ run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			{ PATH: "" },
			// No PATH entry and no bundled copy either.
			() => null,
		);
		expect(cap.usable).toBe(false);
		expect(cap.reason).toMatch(/no rift binary/);
	});
});

describe("per-agent workspaces", () => {
	it("uses rift when it works, one tree per agent", async () => {
		const created: string[] = [];
		const runner: RiftRunner = {
			run: async (args) => {
				if (args[0] === "list") return { code: 0, stdout: "", stderr: "" };
				if (args[0] === "init") return { code: 0, stdout: "", stderr: "" };
				const name = must(
					args[args.indexOf("--name") + 1],
					"args[args.indexOf('--name') + 1]",
				);
				created.push(name);
				return { code: 0, stdout: `/rifts/${name}\n`, stderr: "" };
			},
		};
		const result = await allocateAgentWorkspaces({
			workspaceRoot: "/ws",
			agentIds: ["claude", "codex"],
			fallbackRoot: "/fallback",
			runner,
			env: { PATH: fakeRiftBin() },
			git: async () => ({ code: 0, stderr: "" }),
		});
		expect(result.backend).toBe("rift");
		expect(created).toEqual(["claude", "codex"]);
		expect(result.workspaces.map((w) => w.path)).toEqual([
			"/rifts/claude",
			"/rifts/codex",
		]);
	});

	it("falls back to git worktrees and says why", async () => {
		const repo = tmp();
		mkdirSync(join(repo, ".git"), { recursive: true });
		const pkg = join(repo, "packages", "code");
		mkdirSync(pkg, { recursive: true });
		const fallback = join(tmp(), "workspaces");
		const cuts: string[] = [];
		const result = await allocateAgentWorkspaces({
			// The devenv workspace is a package inside the repo — the worktree
			// must still be cut from the enclosing git root.
			workspaceRoot: pkg,
			agentIds: ["claude"],
			fallbackRoot: fallback,
			runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			env: { PATH: "" },
			bundled: () => null,
			git: async (args, cwd) => {
				cuts.push(cwd);
				mkdirSync(must(args[args.length - 2]), {
					recursive: true,
				});
				return { code: 0, stderr: "" };
			},
		});
		expect(result.backend).toBe("git-worktree");
		expect(cuts).toEqual([repo]);
		expect(result.reason).toMatch(/no rift binary/);
		expect(first(result.workspaces).path).toBe(join(fallback, "claude"));
	});

	it("shares the workspace only when asked", async () => {
		const result = await allocateAgentWorkspaces({
			workspaceRoot: "/ws",
			agentIds: ["a", "b"],
			fallbackRoot: "/fallback",
			shared: true,
		});
		expect(result.backend).toBe("shared");
		expect(result.workspaces.every((w) => w.path === "/ws")).toBe(true);
	});

	it("findGitRoot walks up to the enclosing repository", () => {
		const repo = tmp();
		mkdirSync(join(repo, ".git"), { recursive: true });
		const deep = join(repo, "a", "b", "c");
		mkdirSync(deep, { recursive: true });
		expect(findGitRoot(deep)).toBe(repo);
		expect(findGitRoot("/nowhere/at/all", () => false)).toBeNull();
	});
});

describe("sidecar preference", () => {
	it("picks hobo-rift over upstream rift when both are on PATH", () => {
		const dir = mkdtempSync(join(tmpdir(), "riftbin-"));
		for (const name of ["rift", "hobo-rift"]) {
			writeFileSync(join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
		}
		const found = resolveRiftBinary({ PATH: dir }, () => null);
		// Upstream needs btrfs/XFS-reflink/APFS and ships no binary for every
		// platform; the sidecar works where it cannot, so it must win.
		expect(found?.flavor).toBe("hobo");
		expect(found?.path).toBe(join(dir, "hobo-rift"));
		rmSync(dir, { recursive: true, force: true });
	});

	it("falls back to upstream rift when the sidecar is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "riftbin-"));
		writeFileSync(join(dir, "rift"), "#!/bin/sh\n", { mode: 0o755 });
		expect(resolveRiftBinary({ PATH: dir }, () => null)?.flavor).toBe(
			"upstream",
		);
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports no binary rather than guessing one", () => {
		expect(resolveRiftBinary({ PATH: "" }, () => null)).toBeNull();
	});
});

describe("entering a namespace-mounted workspace", () => {
	it("runs the pane command through hobo-rift exec, not cd", () => {
		// `cd` into an overlay merged path from outside the user namespace
		// lands in an empty directory, so the agent would see no repo at all.
		const wrapped = placedCommand({
			name: "claude",
			kind: "local",
			command: "claude",
			cwd: "/ws/.hobo-rift/workspaces/claude/merged",
			exec: { binary: "/usr/bin/hobo-rift", root: "/ws", name: "claude" },
		});
		expect(wrapped).toContain("'/usr/bin/hobo-rift' exec");
		expect(wrapped).toContain("--name 'claude'");
		expect(wrapped).not.toContain("cd '/ws/.hobo-rift");
	});

	it("starts the agent with its environment through hobo-rift exec", () => {
		// hobo-rift takes the command after `--` as an argv vector and quotes
		// each element (`quoteVector`), so a leading `NAME=value` became the
		// command's name, and the agent never started.
		const bin = tmp();
		const seen = join(bin, "effort");
		writeFileSync(
			join(bin, "hobo-rift"),
			'#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
		);
		writeFileSync(
			join(bin, "claude"),
			`#!/bin/sh\necho "$CLAUDE_CODE_EFFORT_LEVEL" > '${seen}'\n`,
		);
		for (const name of ["hobo-rift", "claude"])
			chmodSync(join(bin, name), 0o755);
		const command = applySettingsToSeatCommand(
			"claude",
			"claude",
			defaultHarnessSettings("claude"),
		);
		expect(command).toMatch(/^CLAUDE_CODE_EFFORT_LEVEL=\S+ claude/u);
		const placed = placedCommand({
			name: "claude",
			kind: "local",
			command,
			cwd: "/ws/.hobo-rift/workspaces/claude/merged",
			exec: { binary: join(bin, "hobo-rift"), root: "/ws", name: "claude" },
		});
		const ran = spawnSync("sh", ["-c", placed], {
			env: { PATH: `${bin}:/usr/bin:/bin` },
			encoding: "utf8",
		});
		expect(ran.status, ran.stderr).toBe(0);
		expect(readFileSync(seen, "utf8").trim()).toBe("medium");
	});

	it("still plain-cds for ordinary directory workspaces", () => {
		const plain = placedCommand({
			name: "codex",
			kind: "local",
			command: "codex",
			cwd: "/ws/trees/codex",
		});
		expect(plain).toContain("cd '/ws/trees/codex'");
		expect(plain).not.toContain("hobo-rift exec");
	});
});

describe("re-running mux in the same project", () => {
	it("reuses an existing workspace instead of abandoning rift", async () => {
		// The second `mux` in a project always hits "already exists". Treating
		// that as failure dropped every agent to a git worktree — heavier, and
		// not copy-on-write at all — from the second run onwards.
		const runner: RiftRunner = {
			run: async (args) => {
				if (args[0] === "init") return { code: 0, stdout: "", stderr: "" };
				if (args[0] === "create") {
					return {
						code: 1,
						stdout: "",
						stderr: 'workspace "claude" already exists',
					};
				}
				if (args[0] === "list") {
					return {
						code: 0,
						stderr: "",
						stdout: JSON.stringify({
							root: "/ws",
							workspaces: [
								{
									name: "claude",
									path: "/ws/.hobo-rift/workspaces/claude/merged",
								},
							],
						}),
					};
				}
				return { code: 1, stdout: "", stderr: "unexpected" };
			},
		};
		const created = await createRiftWorkspace("/ws", "claude", runner);
		expect(created.workspace?.path).toBe(
			"/ws/.hobo-rift/workspaces/claude/merged",
		);
	});

	it("still reports the failure when no such workspace exists", async () => {
		const runner: RiftRunner = {
			run: async (args) => {
				if (args[0] === "init") return { code: 0, stdout: "", stderr: "" };
				if (args[0] === "create") {
					return { code: 1, stdout: "", stderr: "disk full" };
				}
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify({ root: "/ws", workspaces: [] }),
				};
			},
		};
		const created = await createRiftWorkspace("/ws", "claude", runner);
		expect(created.workspace).toBeNull();
		expect(created.reason).toMatch(/disk full/);
	});
});

describe("a sidecar that predates the contract", () => {
	/** A runner standing in for an older build: no `contract` in capability. */
	function stale(): RiftRunner {
		return {
			run: async (args) => {
				if (args[0] === "capability") {
					return {
						code: 0,
						stderr: "",
						stdout: JSON.stringify({
							tier: "overlayfs",
							available: ["overlayfs"],
						}),
					};
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		};
	}

	function current(): RiftRunner {
		return {
			run: async (args) => {
				if (args[0] === "capability") {
					return {
						code: 0,
						stderr: "",
						stdout: JSON.stringify({
							tier: "overlayfs",
							contract: { execArgvVector: true, namespaceMarker: true },
						}),
					};
				}
				if (args[0] === "create") {
					return {
						code: 0,
						stderr: "",
						stdout: "/ws/.hobo-rift/workspaces/a/merged\n",
					};
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		};
	}

	it("is not used, because composing against it reintroduces the injection", async () => {
		// An older sidecar accepts the same flags and silently joins its argv,
		// so a workspace path with a space or `;` is split — or executed. PATH
		// is searched first, so a stale binary would otherwise shadow the
		// bundled copy and take every composed command with it.
		const result = await allocateAgentWorkspaces({
			workspaceRoot: "/ws",
			agentIds: ["claude"],
			fallbackRoot: "/fallback",
			runner: stale(),
			env: { PATH: fakeRiftBin("hobo-rift") },
			bundled: () => null,
			git: async () => ({ code: 1, stderr: "no git" }),
		});
		expect(result.backend).not.toBe("rift");
		expect(result.reason).toMatch(/predates the argv\/namespace contract/);
	});

	it("says the contract is met when the sidecar advertises it", async () => {
		const capability = await probeRift("/ws", current(), {
			PATH: fakeRiftBin("hobo-rift"),
		});
		expect(capability.usable).toBe(true);
		expect(speaksContract(capability.contract)).toBe(true);
	});

	it("treats a missing contract as not spoken, not as absent policy", () => {
		expect(speaksContract(undefined)).toBe(false);
		expect(speaksContract({ execArgvVector: true })).toBe(false);
		expect(speaksContract({ namespaceMarker: true })).toBe(false);
		expect(
			speaksContract({ execArgvVector: true, namespaceMarker: true }),
		).toBe(true);
	});
});

describe("the runner follows the env it was given", () => {
	it("does not check one binary and compose against another", async () => {
		// The guard reads the contract through the runner but reports
		// `capability.binary` from `env`. Defaulting the runner from
		// `process.env` let those be different binaries, so a caller passing an
		// env whose PATH held a stale sidecar got the check against the good one
		// and every pane composed against the stale one — silently, with no
		// reason recorded.
		const staleDir = tmp();
		writeFileSync(join(staleDir, "hobo-rift"), "#!/bin/sh\nexit 0\n");
		const seen: string[] = [];
		const result = await allocateAgentWorkspaces({
			workspaceRoot: "/ws",
			agentIds: ["claude"],
			fallbackRoot: join(tmp(), "fallback"),
			// No explicit runner: the default must be built from `env`, not from
			// whatever this process's PATH happens to hold.
			env: { PATH: staleDir },
			bundled: () => null,
			git: async (_args, cwd) => {
				seen.push(cwd);
				return { code: 1, stderr: "no git" };
			},
		});
		for (const w of result.workspaces) {
			// Whatever backend was chosen, no pane may be composed against a
			// binary the check never saw.
			if (w.exec) expect(w.exec.binary).toBe(join(staleDir, "hobo-rift"));
		}
		expect(result.backend).not.toBe("rift");
	});
});
