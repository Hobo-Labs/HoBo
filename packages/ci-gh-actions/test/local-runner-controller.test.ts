import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = fileURLToPath(
	new URL("../scripts/local-runner.ts", import.meta.url),
);
const directories: string[] = [];
function controller() {
	const state = mkdtempSync(join(tmpdir(), "hobo-local-controller-"));
	directories.push(state);
	const command = (operation: string) =>
		exec(process.execPath, ["--import", "tsx", cli, operation], {
			timeout: 15000,
			env: {
				...process.env,
				HOBO_CI_LOCAL_STATE_DIRECTORY: state,
				HOBO_CI_LOCAL_RUNNER: "1",
				HOBO_CI_LOCAL_TRUSTED: "",
				HOBO_CI_LOCAL_REPOSITORY: "",
			},
		});
	const socket = join(
		tmpdir(),
		`hobo-ci-${process.getuid?.()}-${createHash("sha256").update(state).digest("hex").slice(0, 16)}.sock`,
	);
	return { state, command, socket };
}
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

// Each command cold-starts `node --import tsx` (up to 15 s apiece); a test runs
// several, which outlasts vitest's 5 s default on a loaded CI box.
describe("local runner controller lifecycle", { timeout: 60_000 }, () => {
	it("starts once without credentials, reports waiting, and stop waits for drain", async () => {
		const { state, command } = controller();
		try {
			await command("start");
			await command("start");
			expect(JSON.parse((await command("status")).stdout).status).toBe(
				"waiting",
			);
			expect(JSON.parse((await command("stop")).stdout).status).toBe("stopped");
			expect(
				JSON.parse(readFileSync(join(state, "status.json"), "utf8")).status,
			).toBe("stopped");
		} finally {
			await command("stop");
		}
	});
	it("registers no runner while the host's CD agent holds admission closed", async () => {
		const { state, command } = controller();
		// The marker the runner-host agent places to drain this host.
		writeFileSync(join(state, "admission-paused"), "");
		try {
			await command("start");
			let status = "";
			for (let i = 0; i < 50 && status !== "paused"; i++) {
				status = JSON.parse((await command("status")).stdout).status;
				if (status !== "paused") await pause(100);
			}
			expect(status).toBe("paused");
			// Reopened: the controller goes back to its usual loop.
			rmSync(join(state, "admission-paused"));
			for (let i = 0; i < 100 && status === "paused"; i++) {
				await pause(100);
				status = JSON.parse((await command("status")).stdout).status;
			}
			expect(status).toBe("waiting");
		} finally {
			await command("stop");
		}
	});
	it("preserves a blocked recovery status when the controller has exited", async () => {
		const { state, command } = controller();
		const blocked = {
			status: "blocked",
			detail: "Prior runner shutdown is uncertain",
		};
		writeFileSync(join(state, "status.json"), JSON.stringify(blocked));
		expect(JSON.parse((await command("status")).stdout)).toEqual(blocked);
		await expect(command("stop")).rejects.toThrow();
	});
	it("fails stop when a registration still needs cleanup instead of claiming successful drain", async () => {
		const { state, command } = controller();
		const registration = { repository: "owner/repo", id: 41, uncertain: false };
		writeFileSync(
			join(state, "registration.json"),
			JSON.stringify(registration),
		);
		try {
			await command("start");
			await expect(command("stop")).rejects.toThrow();
			expect(JSON.parse((await command("status")).stdout).status).toBe(
				"blocked",
			);
			expect(
				JSON.parse(readFileSync(join(state, "status.json"), "utf8")).status,
			).toBe("blocked");
			expect(
				JSON.parse(readFileSync(join(state, "registration.json"), "utf8")),
			).toEqual(registration);
		} finally {
			await command("stop").catch(() => {});
		}
	});
	it("does not claim shutdown when an existing controller returns an invalid response", async () => {
		const { command, socket } = controller();
		const server = createServer({ allowHalfOpen: true }, (client) => {
			client.resume();
			client.once("end", () => client.end("unavailable"));
		});
		await new Promise<void>((done) => server.listen(socket, done));
		try {
			expect(JSON.parse((await command("status")).stdout).status).toBe(
				"unknown",
			);
			await expect(command("stop")).rejects.toThrow();
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
		}
	});
	it("does not claim shutdown when the recovery state cannot be inspected", async () => {
		const { state, command } = controller();
		rmSync(state, { recursive: true });
		writeFileSync(state, "invalid state directory");
		expect(JSON.parse((await command("status")).stdout).status).toBe("unknown");
		await expect(command("stop")).rejects.toThrow();
	});
});
