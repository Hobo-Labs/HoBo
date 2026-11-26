import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createConnectionCommand } from "../src/connection-command.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

describe("hobo connection command", () => {
	it("create → authorize → list → get → revoke", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-conn-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const cmd = createConnectionCommand({ hoboHome });

		const created = await cmd.run({
			context: { cwd: hoboHome },
			flags: {
				alias: "work",
				scopes: "tasks:read,tasks:write",
				home: hoboHome,
				// Station context is mandatory since Station occupancy (ADR-0131);
				// production gets it from `hobo station init` → profile.defaultStation.
				station: "test-station",
			},
			args: ["create", "asana"],
			emitProgress: () => {},
		});
		expect(created.ok).toBe(true);
		// SAFETY: assertion required at this I/O or test boundary.
		const id = (created.data as { connection: { id: string } }).connection.id;

		const authorized = await cmd.run({
			context: { cwd: hoboHome },
			flags: { home: hoboHome },
			args: ["authorize", "work"],
			emitProgress: () => {},
		});
		expect(authorized.ok).toBe(true);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(authorized.data as { connection: { status: string } }).connection.status,
		).toBe("active");

		const listed = await cmd.run({
			context: { cwd: hoboHome },
			flags: { provider: "asana", home: hoboHome },
			args: ["list"],
			emitProgress: () => {},
		});
		expect(listed.ok).toBe(true);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((listed.data as { count: number }).count).toBe(1);

		const got = await cmd.run({
			context: { cwd: hoboHome },
			flags: { home: hoboHome },
			args: ["get", id],
			emitProgress: () => {},
		});
		expect(got.ok).toBe(true);

		const revoked = await cmd.run({
			context: { cwd: hoboHome },
			flags: { home: hoboHome },
			args: ["revoke", "work"],
			emitProgress: () => {},
		});
		expect(revoked.ok).toBe(true);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(revoked.data as { connection: { status: string } }).connection.status,
		).toBe("revoked");
	});
});
