import { createReplayService } from "@hobo/replay";
import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonObject } from "../src/json.js";

import { createReplayCommand } from "../src/replay-command.js";

function runInput(args: string[], flags: JsonObject = {}) {
	return {
		args,
		flags,
		context: { cwd: "/tmp", projectDir: "/tmp" },
		emitProgress: () => {},
	};
}

describe("hobo replay", () => {
	it("doctor reports default local path and honest scope", async () => {
		const service = createReplayService({
			stationId: "station:local",
			memory: true,
		});
		const cmd = createReplayCommand({ service, env: {} });
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await cmd.run(runInput(["doctor"]) as never);
		expect(result.ok).toBe(true);
		expect(result.data?.package).toBe("@hobo/replay");
		expect(result.data?.defaultLocalOn).toBe(true);
		expect(result.data?.killEnv).toBe("HOBO_REPLAY=0");
	});

	it("list/get/summarize round-trip after recording", async () => {
		const service = createReplayService({
			stationId: "station:local",
			memory: true,
		});
		const tracker = service.startRecording({
			seedEvents: [{ type: 2, timestamp: 1, data: { tagName: "div" } }],
			sessionId: "sess-cli-1",
		});
		await tracker.linkError("err-99");
		await tracker.flush();
		await tracker.stop();

		const cmd = createReplayCommand({ service, env: {} });
		// SAFETY: assertion required at this I/O or test boundary.
		const listed = await cmd.run(runInput(["list"]) as never);
		expect(listed.ok).toBe(true);
		const sessions = listed.data?.sessions;
		expect(
			Array.isArray(sessions) &&
				sessions.some(
					(session) => isJsonObject(session) && session.id === "sess-cli-1",
				),
		).toBe(true);

		const byError = await cmd.run(
			// SAFETY: assertion required at this I/O or test boundary.
			runInput(["list"], { error: "err-99" }) as never,
		);
		const listedByError = byError.data?.sessions;
		expect(
			Array.isArray(listedByError) &&
				listedByError.some(
					(session) => isJsonObject(session) && session.id === "sess-cli-1",
				),
		).toBe(true);

		// SAFETY: assertion required at this I/O or test boundary.
		const got = await cmd.run(runInput(["get", "sess-cli-1"]) as never);
		expect(got.ok).toBe(true);
		// SAFETY: assertion required at this I/O or test boundary.
		const session = got.data?.session;
		expect(isJsonObject(session) && session.id === "sess-cli-1").toBe(true);

		const summary = await cmd.run(
			// SAFETY: assertion required at this I/O or test boundary.
			runInput(["summarize", "sess-cli-1"]) as never,
		);
		expect(summary.ok).toBe(true);
		expect(String(summary.message)).toContain("err-99");

		// SAFETY: assertion required at this I/O or test boundary.
		const opened = await cmd.run(runInput(["open", "sess-cli-1"]) as never);
		expect(opened.ok).toBe(true);
		expect(opened.data?.openUi).toMatchObject({
			kind: "hobo.replay.player",
			mutationSurface: "cli-only",
		});
	});

	it("unknown subcommand returns usage", async () => {
		const cmd = createReplayCommand({
			service: createReplayService({ memory: true }),
			env: {},
		});
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await cmd.run(runInput(["nope"]) as never);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_REPLAY_USAGE");
	});
});
