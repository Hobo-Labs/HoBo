/**
 * stopGroup (ADR-0172, src/process-group.ts): how a stop of ai-bdd's group
 * ends, with a kill function that answers as the kernel would. ESRCH means
 * the kernel found no member; EPERM and EACCES mean members this process may
 * not signal, and the stop says it could not confirm the group ended. The
 * last case drives the check itself, as root without CAP_KILL, against a
 * member that runs as another user.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import {
	groupTarget,
	KILL_CONFIRM_MS,
	type Kill,
	stopGroup,
} from "../src/process-group.js";
import { GROUP, PGID, procTables, zombie } from "./helpers/proc-table.js";
import {
	ALL_PASS,
	FAKE_COMMAND,
	killQuietly,
	REPO_ROOT,
} from "./helpers/release-gate.js";

const tables = procTables();
afterAll(tables.remove);

type Answer = "ok" | "ESRCH" | "EPERM" | "EACCES";
type Sent = NodeJS.Signals | 0;

/** A kill that answers each call with `answer(signal, signals sent before it)`, and keeps what it was sent. */
function fakeKill(answer: (signal: Sent, before: readonly Sent[]) => Answer) {
	const sent: Sent[] = [];
	const kill: Kill = (pid, signal) => {
		expect(pid).toBe(-PGID);
		const given = answer(signal, [...sent]);
		sent.push(signal);
		if (given !== "ok") {
			throw Object.assign(new Error(`kill ${given}`), { code: given });
		}
	};
	return { kill, sent };
}

/** ok until SIGKILL has been sent, then `after`. */
const untilKilled =
	(after: Answer) =>
	(_signal: Sent, before: readonly Sent[]): Answer =>
		before.includes("SIGKILL") ? after : "ok";

describe("stopGroup, with a kill that answers as the kernel would", () => {
	it("is gone when the first signal finds no member (ESRCH), and sends nothing more", async () => {
		const { kill, sent } = fakeKill(() => "ESRCH");
		const stop = await stopGroup(groupTarget(GROUP, { kill }), "SIGTERM", 300);
		expect(stop).toEqual({ kind: "gone" });
		expect(sent).toEqual(["SIGTERM"]);
	});

	it("is killed once SIGKILL, sent when the grace ended, has landed", async () => {
		const { kill, sent } = fakeKill(untilKilled("ESRCH"));
		const started = Date.now();
		const stop = await stopGroup(groupTarget(GROUP, { kill }), "SIGTERM", 300);
		expect(stop).toEqual({ kind: "killed" });
		expect(Date.now() - started).toBeGreaterThanOrEqual(300);
		expect(sent.at(0)).toBe("SIGTERM");
		expect(sent.slice(-2)).toEqual(["SIGKILL", 0]);
	});

	it("is killed at once when /proc shows only zombies", async () => {
		const { kill, sent } = fakeKill(() => "ok");
		const started = Date.now();
		const stop = await stopGroup(
			groupTarget(GROUP, { kill, procRoot: tables.table([zombie(100)]) }),
			"SIGTERM",
			5000,
		);
		expect(stop).toEqual({ kind: "killed" });
		expect(sent).toEqual(["SIGTERM", 0, "SIGKILL", 0]);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("is gone, with no SIGKILL, once its pgid leads another session's group: the number was reused", async () => {
		const { kill, sent } = fakeKill(() => "ok");
		const stranger = { ...zombie(100), state: "S", session: 77 };
		const stop = await stopGroup(
			groupTarget(GROUP, { kill, procRoot: tables.table([stranger]) }),
			"SIGTERM",
			300,
		);
		expect(stop).toEqual({ kind: "gone" });
		expect(sent).toEqual(["SIGTERM", 0]);
	});

	it("is unconfirmed, at once and with nothing more sent, when the first signal is answered EPERM", async () => {
		const { kill, sent } = fakeKill(() => "EPERM");
		const stop = await stopGroup(groupTarget(GROUP, { kill }), "SIGINT", 300);
		expect(stop).toEqual({
			kind: "unconfirmed",
			reason: `process group ${PGID}: kill answered EPERM: members this check may not signal (another user's) are left`,
		});
		expect(sent).toEqual(["SIGINT"]);
	});

	it("is unconfirmed, with no SIGKILL, when a poll is answered EACCES", async () => {
		const { kill, sent } = fakeKill((signal) =>
			signal === 0 ? "EACCES" : "ok",
		);
		const stop = await stopGroup(groupTarget(GROUP, { kill }), "SIGTERM", 5000);
		expect(stop).toEqual({
			kind: "unconfirmed",
			reason: `process group ${PGID}: kill answered EACCES: a security module refused the signal, so members are left`,
		});
		expect(sent).toEqual(["SIGTERM", 0]);
	});

	it("is unconfirmed when members are still running KILL_CONFIRM_MS after SIGKILL, without claiming it reached them", async () => {
		// With another user's member beside one of ours, kill(-pgid, 0) keeps finding our
		// zombie, so no EPERM ever shows. The reason must not say SIGKILL reached the other,
		// nor that it never can: a caller with CAP_KILL signals any user's process.
		const { kill, sent } = fakeKill(() => "ok");
		const started = Date.now();
		const stop = await stopGroup(groupTarget(GROUP, { kill }), "SIGTERM", 300);
		expect(stop).toEqual({
			kind: "unconfirmed",
			reason: `process group ${PGID}: members were still running ${KILL_CONFIRM_MS} ms after SIGKILL was sent to the group (SIGKILL cannot reach another user's members unless the check has CAP_KILL, and may not have ended the rest yet)`,
		});
		expect(sent).toContain("SIGKILL");
		expect(Date.now() - started).toBeGreaterThanOrEqual(300 + KILL_CONFIRM_MS);
	});

	it("is unconfirmed when, after SIGKILL, only members this check may not signal are left (EPERM)", async () => {
		const { kill } = fakeKill(untilKilled("EPERM"));
		const stop = await stopGroup(groupTarget(GROUP, { kill }), "SIGTERM", 300);
		expect(stop).toMatchObject({
			kind: "unconfirmed",
			reason: expect.stringContaining("kill answered EPERM"),
		});
	});
});

/** Root, on Linux, with setpriv: the check can be run without CAP_KILL and a member made another user. */
const CAN_DROP_KILL =
	process.platform === "linux" &&
	process.getuid?.() === 0 &&
	spawnSync("setpriv", ["--version"]).status === 0;

describe("the check, when kill answers EPERM", () => {
	it.runIf(CAN_DROP_KILL)(
		"records not_run with the reason: a member of another user outlived ai-bdd, and the check may not signal it",
		() => {
			// As the command sudo or su runs is: another real uid, which ignores SIGTERM. The
			// shell says so in $READY once /proc shows the member's uid changed, and only
			// then exits: a SIGKILL sent before the change would reach it.
			const ready = join(
				tmpdir(),
				`hobo-eperm-${process.pid}-${Date.now()}.ready`,
			);
			const member = `trap '' TERM; setpriv --reuid=65534 --regid=65534 --clear-groups sleep 20 >/dev/null 2>&1 & m=$!; echo holder $m >&2; i=0; until grep -q '^Uid:[[:space:]]*65534[[:space:]]' /proc/$m/status 2>/dev/null || [ $i -ge 400 ]; do sleep 0.05; i=$((i+1)); done; [ $i -lt 400 ] && : > "$READY"; exit 0`;
			const check = spawnSync(
				"setpriv",
				[
					"--bounding-set=-kill",
					process.execPath,
					"--import",
					"tsx",
					"packages/stage-gate/scripts/check-acceptance.mts",
					"plans-fresh",
				],
				{
					cwd: REPO_ROOT,
					env: {
						...process.env,
						HOBO_AI_BDD_CMD: JSON.stringify(["sh", "-c", member]),
						HOBO_AI_BDD_PROJECT: tmpdir(),
						READY: ready,
					},
					encoding: "utf8",
					timeout: 30_000,
				},
			);
			const holder = Number(/holder (\d+)/u.exec(check.stderr)?.[1] ?? 0);
			try {
				expect(existsSync(ready)).toBe(true);
				const evidenceLine = check.stdout.trim().split("\n").at(-1) ?? "";
				expect(evidenceLine).toContain('"outcome":"not_run"');
				expect(evidenceLine).toContain(
					"the check could not confirm its process group stopped",
				);
				expect(evidenceLine).toContain("kill answered EPERM");
				expect(check.status).toBe(3);
			} finally {
				killQuietly(holder);
				rmSync(ready, { force: true });
			}
		},
		40_000,
	);

	it.runIf(CAN_DROP_KILL)(
		"records replay not_run, its report not read, when ai-bdd passed but a member of another user outlived it",
		() => {
			// ai-bdd is the tests' stand-in, writing a passing report; its group also keeps a
			// member of another uid that ignores SIGTERM. Only the stop can tell.
			const project = mkdtempSync(join(tmpdir(), "hobo-replay-eperm-"));
			const log = join(project, "calls.log");
			writeFileSync(log, "");
			const wrapped =
				'trap \'\' TERM; setpriv --reuid=65534 --regid=65534 --clear-groups sleep 20 >/dev/null 2>&1 & echo holder $! >&2; exec "$0" "$@"';
			const check = spawnSync(
				"setpriv",
				[
					"--bounding-set=-kill",
					process.execPath,
					"--import",
					"tsx",
					"packages/stage-gate/scripts/check-acceptance.mts",
					"replay",
				],
				{
					cwd: REPO_ROOT,
					env: {
						...process.env,
						HOBO_AI_BDD_CMD: JSON.stringify([
							"sh",
							"-c",
							wrapped,
							...FAKE_COMMAND,
						]),
						HOBO_AI_BDD_PROJECT: project,
						FAKE_AI_BDD: JSON.stringify(ALL_PASS),
						FAKE_AI_BDD_LOG: log,
					},
					encoding: "utf8",
					timeout: 30_000,
				},
			);
			const holder = Number(/holder (\d+)/u.exec(check.stderr)?.[1] ?? 0);
			try {
				const evidenceLine = check.stdout.trim().split("\n").at(-1) ?? "";
				expect(evidenceLine).toContain('"outcome":"not_run"');
				expect(evidenceLine).toContain('"step":"replay"');
				expect(evidenceLine).toContain('"report":"not read"');
				expect(evidenceLine).toContain("kill answered EPERM");
				expect(check.status).toBe(3);
			} finally {
				killQuietly(holder);
				rmSync(project, { recursive: true, force: true });
			}
		},
		40_000,
	);
});
