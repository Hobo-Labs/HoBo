import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createSelfUpdater,
	SELF_CHECK_ARGUMENT,
	SELF_UPDATE_DEFAULT_ENTRY,
	SELF_UPDATE_PATHS,
	SELF_UPDATE_REFUSAL_HOLD_MS,
	worktreePaths,
} from "../src/isolated-worker/self-update.js";

const CURRENT = "a".repeat(40);
const HEAD = "b".repeat(40);
const MIDDLE = "c".repeat(40);
const ROOT = "/srv/hobo";
const WORKTREES = "/var/lib/hobo-ci/self-update";
const HOUR = 60 * 60_000;

class Exec extends Error {}

type Call = Readonly<{ kind: string; args: readonly string[]; cwd?: string }>;

function box(
	options: {
		head?: string;
		firstParentOfOldest?: string;
		changed?: string;
		failStep?: string;
		execve?: boolean;
		execveThrows?: number;
		idle?: () => boolean;
		enabled?: boolean;
		fetchFails?: boolean;
	} = {},
) {
	let clock = 1_000_000;
	const calls: Call[] = [];
	const events: {
		event: string;
		fields: Readonly<Record<string, string | number | boolean>>;
	}[] = [];
	let execveThrows = options.execveThrows ?? 0;
	let stopped = 0;
	const head = options.head ?? HEAD;
	const updater = createSelfUpdater({
		settings: { enabled: options.enabled ?? true, intervalHours: 3 },
		checkoutRoot: ROOT,
		currentCommit: CURRENT,
		worktreesRoot: WORKTREES,
		entry: SELF_UPDATE_DEFAULT_ENTRY,
		args: ["--keep"],
		execPath: "/usr/bin/node",
		execArgv: ["--experimental-strip-types"],
		env: { PATH: "/usr/bin" },
		git: async (args, cwd) => {
			calls.push({ kind: "git", args, cwd });
			const joined = args.join(" ");
			if (args[0] === "fetch" && options.fetchFails) throw new Error("network");
			if (args[0] === "rev-parse" && args[2]?.startsWith("refs/remotes"))
				return `${head}\n`;
			if (args[0] === "rev-list") return `${HEAD}\n${MIDDLE}\n`;
			if (args[0] === "rev-parse" && args[2] === `${MIDDLE}^1`)
				return `${options.firstParentOfOldest ?? CURRENT}\n`;
			if (args[0] === "diff")
				return options.changed ?? "packages/ci-gh-actions/src/x.ts\n";
			if (joined === "worktree list --porcelain")
				return `worktree ${ROOT}\nHEAD ${CURRENT}\n\nworktree ${WORKTREES}/${"d".repeat(40)}\nHEAD ${"d".repeat(40)}\n`;
			if (args[0] === "worktree" && args[1] === "add") {
				if (options.failStep === "worktree") throw new Error("disk full");
			}
			return "";
		},
		run: async (command, args, cwd, env) => {
			calls.push({ kind: "run", args: [command, ...args], cwd });
			const step = args.includes(SELF_CHECK_ARGUMENT)
				? "self-check"
				: args.includes("install")
					? "install"
					: args.includes("submodule")
						? "submodules"
						: "build";
			if (step === "self-check") expect(env.HOBO_CI_WORKER_BUILD).toBe("0");
			if (options.failStep === step) throw new Error(`${step} failed`);
		},
		idle: options.idle ?? (() => true),
		stop: async () => {
			stopped += 1;
			calls.push({ kind: "stop", args: [] });
		},
		execve:
			options.execve === false
				? undefined
				: (file, args) => {
						calls.push({ kind: "execve", args: [file, ...args] });
						if (execveThrows > 0) {
							execveThrows -= 1;
							throw new Error("ENOEXEC");
						}
						return new Promise<never>(() => undefined);
					},
		exit: (code) => {
			calls.push({ kind: "exit", args: [String(code)] });
			throw new Exec(`exit ${code}`);
		},
		log: (event, fields = {}) => events.push({ event, fields }),
		now: () => clock,
	});
	return {
		updater,
		calls,
		events,
		stopped: () => stopped,
		advance: (ms: number) => {
			clock += ms;
		},
		named: (event: string) => events.filter((entry) => entry.event === event),
		kinds: () => calls.map((call) => call.kind),
	};
}

async function tick(updater: ReturnType<typeof box>["updater"]) {
	try {
		return await Promise.race([
			updater.tick(),
			new Promise<string>((resolve) =>
				setTimeout(() => resolve("replaced"), 50),
			),
		]);
	} catch (error) {
		if (error instanceof Exec) return error.message;
		throw error;
	}
}

describe("self-update (ADR-0181, 3.8; M10)", () => {
	it("looks only once an interval has passed, only when idle, never when disabled", async () => {
		const off = box({ enabled: false });
		off.advance(10 * HOUR);
		expect(await tick(off.updater)).toBe("disabled");
		expect(off.calls).toEqual([]);

		let idle = false;
		const b = box({ idle: () => idle });
		expect(await tick(b.updater)).toBe("not-due");
		b.advance(3 * HOUR);
		expect(await tick(b.updater)).toBe("busy");
		expect(b.calls).toEqual([]);
		idle = true;
		expect(await tick(b.updater)).toBe("replaced");
	});

	it("prepares the new head in a separate worktree, then stops with handoff and re-execs in place", async () => {
		const b = box();
		b.advance(3 * HOUR);
		expect(await tick(b.updater)).toBe("replaced");
		const dir = `${WORKTREES}/${HEAD}`;
		const runs = b.calls.filter((call) => call.kind === "run");
		expect(runs.map((call) => call.args)).toEqual([
			["pnpm", "install", "--frozen-lockfile"],
			["git", "submodule", "update", "--init", "--recursive"],
			[
				"pnpm",
				"exec",
				"turbo",
				"run",
				"build",
				"--filter=@hobo/ci-gh-actions",
				"--output-logs=errors-only",
			],
			[
				"/usr/bin/node",
				"--experimental-strip-types",
				`${dir}/${SELF_UPDATE_DEFAULT_ENTRY}`,
				SELF_CHECK_ARGUMENT,
			],
		]);
		for (const run of runs) expect(run.cwd).toBe(dir);
		expect(
			b.calls.some(
				(call) =>
					call.kind === "git" &&
					call.args.join(" ") === `worktree add --detach ${dir} ${HEAD}`,
			),
		).toBe(true);
		const removed = b.calls
			.filter(
				(call) =>
					call.kind === "git" &&
					call.args[0] === "worktree" &&
					call.args[1] === "remove",
			)
			.map((call) => call.args.at(-1));
		expect(removed).toEqual([`${WORKTREES}/${"d".repeat(40)}`]);
		const order = b.kinds().filter((kind) => kind !== "git");
		expect(order.slice(-2)).toEqual(["stop", "execve"]);
		expect(b.calls.at(-1)?.args).toEqual([
			"/usr/bin/node",
			"/usr/bin/node",
			"--experimental-strip-types",
			`${dir}/${SELF_UPDATE_DEFAULT_ENTRY}`,
			"--keep",
		]);
		expect(b.named("hobo_ci_self_update_restarting")[0]?.fields).toMatchObject({
			from: CURRENT,
			head: HEAD,
		});
	});

	it("diffs only the daemon's own paths", async () => {
		const b = box({ changed: "" });
		b.advance(3 * HOUR);
		expect(await tick(b.updater)).toBe("unchanged");
		const diff = b.calls.find((call) => call.args[0] === "diff");
		expect(diff?.args).toEqual([
			"diff",
			"--name-only",
			CURRENT,
			HEAD,
			"--",
			...SELF_UPDATE_PATHS,
		]);
		expect(SELF_UPDATE_PATHS).toEqual(
			expect.arrayContaining([
				".hobo/ci.json",
				"packages/ci-gh-actions",
				"packages/ci",
				"pnpm-lock.yaml",
			]),
		);
		expect(b.kinds()).not.toContain("run");
		expect(b.stopped()).toBe(0);
	});

	it("watches every workspace package the daemon runs", () => {
		const root = fileURLToPath(new URL("../../../", import.meta.url));
		const Manifest = z.object({
			name: z.string(),
			dependencies: z.record(z.string(), z.string()).optional(),
		});
		const directories = new Map<string, string>();
		for (const pattern of [
			"packages/*/package.json",
			"packages/*/*/package.json",
		])
			for (const file of globSync(pattern, { cwd: root })) {
				const manifest = Manifest.safeParse(
					JSON.parse(readFileSync(join(root, file), "utf8")),
				);
				if (manifest.success)
					directories.set(manifest.data.name, dirname(file));
			}
		const reached = new Set<string>();
		const pending = ["@hobo/ci-gh-actions"];
		for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
			const directory = directories.get(name);
			if (reached.has(name) || directory === undefined) continue;
			reached.add(name);
			const manifest = Manifest.parse(
				JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8")),
			);
			for (const [dependency, range] of Object.entries(
				manifest.dependencies ?? {},
			))
				if (range.startsWith("workspace:")) pending.push(dependency);
		}
		const watched = [...reached].map((name) => directories.get(name));
		expect(SELF_UPDATE_PATHS).toEqual(expect.arrayContaining(watched));
	});

	it("moves only forward along main's first-parent line", async () => {
		const merged = box({ firstParentOfOldest: "e".repeat(40) });
		merged.advance(3 * HOUR);
		expect(await tick(merged.updater)).toBe("off-main");
		expect(
			merged.named("hobo_ci_self_update_skipped")[0]?.fields,
		).toMatchObject({ reason: "off-main" });
		expect(merged.kinds()).not.toContain("run");

		const same = box({ head: CURRENT });
		same.advance(3 * HOUR);
		expect(await tick(same.updater)).toBe("current");
		expect(same.kinds()).not.toContain("run");
	});

	it("never re-execs onto a head whose preparation failed, and skips it for 24 hours", async () => {
		for (const step of [
			"worktree",
			"install",
			"submodules",
			"build",
			"self-check",
		]) {
			const b = box({ failStep: step });
			b.advance(3 * HOUR);
			expect(await tick(b.updater), step).toBe("refused");
			expect(b.stopped(), step).toBe(0);
			expect(b.kinds(), step).not.toContain("execve");
			expect(b.kinds(), step).not.toContain("exit");
			const refused = b.named("hobo_ci_self_update_refused");
			expect(refused).toHaveLength(1);
			expect(refused[0]?.fields).toMatchObject({ head: HEAD, step });
			expect(
				b.calls.some(
					(call) =>
						call.args.join(" ") ===
						`worktree remove --force ${WORKTREES}/${HEAD}`,
				),
			).toBe(true);
			b.advance(3 * HOUR);
			const before = b.calls.length;
			expect(await tick(b.updater)).toBe("held");
			expect(b.calls.slice(before).some((call) => call.kind === "run")).toBe(
				false,
			);
			b.advance(SELF_UPDATE_REFUSAL_HOLD_MS);
			expect(await tick(b.updater)).toBe("refused");
		}
	});

	it("without process.execve it logs ready once and keeps running", async () => {
		const b = box({ execve: false });
		b.advance(3 * HOUR);
		expect(await tick(b.updater)).toBe("ready");
		expect(b.named("hobo_ci_self_update_ready")[0]?.fields).toMatchObject({
			head: HEAD,
			reason: "execve-unavailable",
		});
		expect(b.stopped()).toBe(0);
		expect(b.kinds()).not.toContain("exit");
		b.advance(3 * HOUR);
		const before = b.calls.length;
		expect(await tick(b.updater)).toBe("ready");
		expect(b.calls.slice(before).some((call) => call.kind === "run")).toBe(
			false,
		);
		expect(b.named("hobo_ci_self_update_ready")).toHaveLength(1);
	});

	it("waits for an idle box before starting a prepared head", async () => {
		let idleAnswers = [true, false];
		const b = box({ idle: () => idleAnswers.shift() ?? true });
		b.advance(3 * HOUR);
		expect(await tick(b.updater)).toBe("busy");
		expect(b.stopped()).toBe(0);
		const runs = b.calls.filter((call) => call.kind === "run").length;
		idleAnswers = [];
		expect(await tick(b.updater)).toBe("replaced");
		expect(b.calls.filter((call) => call.kind === "run")).toHaveLength(runs);
		expect(b.stopped()).toBe(1);
	});

	it("falls back to the old code in place when the new one cannot be exec'd", async () => {
		const b = box({ execveThrows: 1 });
		b.advance(3 * HOUR);
		expect(await tick(b.updater)).toBe("replaced");
		const execs = b.calls.filter((call) => call.kind === "execve");
		expect(execs.map((call) => call.args[3])).toEqual([
			`${WORKTREES}/${HEAD}/${SELF_UPDATE_DEFAULT_ENTRY}`,
			`${ROOT}/${SELF_UPDATE_DEFAULT_ENTRY}`,
		]);
		expect(b.named("hobo_ci_self_update_exec_failed")).toHaveLength(1);

		const neither = box({ execveThrows: 2 });
		neither.advance(3 * HOUR);
		expect(await tick(neither.updater)).toBe("exit 1");
	});

	it("a failed fetch refuses nothing", async () => {
		const b = box({ fetchFails: true });
		b.advance(3 * HOUR);
		expect(await tick(b.updater)).toBe("fetch-failed");
		expect(b.named("hobo_ci_self_update_refused")).toHaveLength(0);
		expect(b.named("hobo_ci_self_update_check_failed")).toHaveLength(1);
	});

	it("reads worktree paths from porcelain output", () => {
		expect(
			worktreePaths("worktree /a\nHEAD x\n\nworktree /b c\nbare\n"),
		).toEqual(["/a", "/b c"]);
	});

	it("the daemon's --self-check entry loads every module and the committed policy, starts nothing, and exits 0", () => {
		const entry = fileURLToPath(
			new URL("../scripts/isolated-worker-daemon.mts", import.meta.url),
		);
		const checked = spawnSync(process.execPath, [entry, SELF_CHECK_ARGUMENT], {
			env: { PATH: process.env.PATH, HOBO_CI_WORKER_BUILD: "0" },
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(checked.status, checked.stderr).toBe(0);
		expect(checked.stderr).toMatch(
			/"event":"hobo_ci_self_check_passed".*"routingPolicy":"committed"/u,
		);
	}, 90_000);
});
