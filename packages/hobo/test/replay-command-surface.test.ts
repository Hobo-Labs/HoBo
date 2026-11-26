/**
 * `hobo replay` — the Session Replay observe surface (ADR-0137).
 *
 * Session Replay is not control-plane event-log replay and not auth
 * `session.*` events. Three names for three unrelated things is a standing
 * hazard, and the command carries a note saying so in every `doctor` payload
 * for exactly that reason.
 *
 * **Which store the command reads is decided before anything is read.** A
 * station id resolves flag → env → profile → `station:local`, and the service
 * is either the injected one, the in-memory contract fixtures, or a real
 * directory under that station. Reading the wrong station's captures is not an
 * error anyone would notice — it is an empty list, or worse, someone else's
 * sessions.
 *
 * **A missing session is a refusal, not an empty success.** `get`, `open`, and
 * `summarize` all name a specific capture; answering "ok, nothing here" would
 * make a typo in a session id indistinguishable from a capture that was pruned
 * by retention.
 *
 * **`open` never inlines the events.** A replay's event array is the bulk of
 * it, and a CLI envelope carrying it would be unusable in a terminal and
 * expensive to produce. The payload says `eventsOmitted: true` so a consumer
 * knows the omission is deliberate rather than an empty capture.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplayService } from "@hobo/replay";
import { afterEach, describe, expect, it } from "vitest";

import { HOBO_PROFILE_SCHEMA, saveHoboProfile } from "../src/hobo-profile.js";
import {
	createReplayCommand,
	type ReplayCommandDeps,
} from "../src/replay-command.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-replay-"));
	dirs.push(dir);
	return dir;
}

const SESSION = {
	id: "session-1",
	status: "closed",
	correlation: {
		errorId: "err-1",
		trailId: "trail-1",
		harnessFlagKeys: ["flag-a"],
	},
	chunkCount: 3,
	totalBytes: 2048,
	summary: "3 chunks, 2 KiB",
};

/** A service that records what it was asked and answers what a test needs. */
function fakeService(
	overrides: Partial<ReplayService> = {},
): ReplayService & { readonly listArgs: unknown[] } {
	const listArgs: unknown[] = [];
	return {
		listArgs,
		doctor: () => ({
			package: "@hobo/replay",
			stationId: "station:test",
			killEnv: "HOBO_REPLAY",
		}),
		list: async (query: unknown) => {
			listArgs.push(query);
			return [SESSION];
		},
		get: async () => SESSION,
		summarize: async () => "session-1: 3 chunks",
		open: async () => ({
			ok: true,
			summary: "opened session-1",
			payload: {
				deepLink: "hobo://replay/session-1",
				openUi: false,
				events: [{ t: 0 }, { t: 1 }],
			},
		}),
		retention: async () => ({ scanned: 5, erased: 2, retained: 3 }),
		...overrides,
	} as ReplayService & { readonly listArgs: unknown[] };
}

const progress: string[] = [];

async function run(
	args: readonly string[] = [],
	options: {
		readonly flags?: Record<string, unknown>;
		readonly env?: NodeJS.ProcessEnv;
		readonly hoboHome?: string;
		readonly service?: ReplayService;
	} = {},
) {
	progress.length = 0;
	const deps: ReplayCommandDeps = {
		env: options.env ?? {},
		hoboHome: options.hoboHome ?? home(),
		...(options.service ? { service: options.service } : {}),
	};
	return createReplayCommand(deps).run({
		context: { cwd: "/" } as never,
		flags: (options.flags ?? {}) as never,
		args: [...args],
		emitProgress: (line: string) => {
			progress.push(line);
		},
	} as never);
}

describe("subcommand dispatch", () => {
	it("defaults to list", async () => {
		// `hobo replay` with nothing else is "what captures do I have?", and a
		// usage error there would make the discovery command the failing one.
		const result = await run([], { service: fakeService() });
		expect((result.data as { subcommand: string }).subcommand).toBe("list");
	});

	it("refuses an unknown subcommand, quoting it", async () => {
		const result = await run(["frobnicate"], { service: fakeService() });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_REPLAY_USAGE");
		expect(result.message).toContain("frobnicate");
	});

	it("shows every subcommand with its argument shape", async () => {
		// Three of the six take a session id and three do not. A bare list of
		// names would leave the user to discover that by trial.
		const remediation = (
			(await run(["nope"], { service: fakeService() })).remediation ?? []
		).join(" ");
		for (const line of [
			"hobo replay list",
			"hobo replay get <sessionId>",
			"hobo replay open <sessionId>",
			"hobo replay summarize <sessionId>",
			"hobo replay retention",
			"hobo replay doctor",
		]) {
			expect(remediation).toContain(line);
		}
	});

	it("names the two environment switches in its refusal", async () => {
		// Capture-off and fixtures-on are the two states a confused user is
		// most likely in, and neither is discoverable from the subcommand list.
		const remediation = (
			(await run(["nope"], { service: fakeService() })).remediation ?? []
		).join(" ");
		expect(remediation).toContain("HOBO_REPLAY=0");
		expect(remediation).toContain("HOBO_REPLAY_FIXTURES=1");
	});
});

describe("station resolution", () => {
	it("accepts the station from --station or --id", async () => {
		// `--id` is the older spelling. Dropping it would silently redirect
		// existing scripts to the default station rather than failing loudly.
		for (const flags of [{ station: "station:a" }, { id: "station:a" }]) {
			const result = await run(["list"], { flags, service: fakeService() });
			expect((result.data as { stationId: string }).stationId).toBe(
				"station:a",
			);
		}
	});

	it("falls back to the environment, then the profile, then station:local", async () => {
		// Reading the wrong station's captures produces an empty list, not an
		// error — so the precedence has to be pinned rather than inferred.
		const dir = home();
		saveHoboProfile(dir, {
			schemaVersion: HOBO_PROFILE_SCHEMA,
			updatedAt: "2026-01-01T00:00:00.000Z",
			defaultStation: { id: "station:profile" },
		});
		expect(
			(
				(
					await run(["list"], {
						hoboHome: dir,
						env: { HOBO_STATION: "station:env" },
						service: fakeService(),
					})
				).data as { stationId: string }
			).stationId,
		).toBe("station:env");
		expect(
			(
				(await run(["list"], { hoboHome: dir, service: fakeService() }))
					.data as { stationId: string }
			).stationId,
		).toBe("station:profile");
		expect(
			(
				(await run(["list"], { hoboHome: home(), service: fakeService() }))
					.data as { stationId: string }
			).stationId,
		).toBe("station:local");
	});

	it("ignores empty flag and environment values", async () => {
		// An exported-but-empty HOBO_STATION would otherwise scope every command
		// to a station whose id is the empty string.
		const result = await run(["list"], {
			hoboHome: home(),
			flags: { station: "" },
			env: { HOBO_STATION: "" },
			service: fakeService(),
		});
		expect((result.data as { stationId: string }).stationId).toBe(
			"station:local",
		);
	});
});

describe("service selection", () => {
	it("uses the in-memory fixtures when either fixture switch is set", async () => {
		// Both spellings exist and both are documented; honouring only one would
		// leave a user with a variable that appears to do nothing.
		for (const env of [
			{ HOBO_REPLAY_FIXTURES: "1" },
			{ HOBO_REPLAY_MEMORY: "1" },
		]) {
			const result = await run(["doctor"], { hoboHome: home(), env });
			expect(result.ok).toBe(true);
			expect(result.code).toBe("HOBO_REPLAY_DOCTOR");
		}
	});

	it("prefers an injected service over any environment switch", async () => {
		// Tests and embedders wire their own store. An env variable overriding
		// it would make the injected seam unreliable exactly where it matters.
		const service = fakeService();
		const result = await run(["retention"], {
			env: { HOBO_REPLAY_FIXTURES: "1" },
			service,
		});
		expect((result.data as { scanned: number }).scanned).toBe(5);
	});
});

describe("doctor", () => {
	it("reports the package, station, and kill switch", async () => {
		const result = await run(["doctor"], { service: fakeService() });
		expect(result.ok).toBe(true);
		const data = result.data as {
			package: string;
			stationId: string;
			killEnv: string;
		};
		expect(data.package).toBe("@hobo/replay");
		expect(data.stationId).toBe("station:test");
		expect(result.message).toContain("kill=HOBO_REPLAY");
	});

	it("reports the kill switch's current value, including when unset", async () => {
		// "There is a kill switch called HOBO_REPLAY" and "capture is currently
		// off" are different facts. `null` says the variable is unset, which is
		// what a user who thinks they disabled capture needs to see.
		expect(
			(
				(await run(["doctor"], { service: fakeService() })).data as {
					envKill: string | null;
				}
			).envKill,
		).toBeNull();
		expect(
			(
				(
					await run(["doctor"], {
						env: { HOBO_REPLAY: "0" },
						service: fakeService(),
					})
				).data as { envKill: string | null }
			).envKill,
		).toBe("0");
	});

	it("carries the note distinguishing it from event-log replay", async () => {
		// Three unrelated things share the word "replay" in this system. The
		// note is the cheapest place to stop an operator debugging the wrong one.
		const note = (
			(await run(["doctor"], { service: fakeService() })).data as {
				note: string;
			}
		).note;
		expect(note).toContain("control-plane event-log replay");
		expect(note).toContain("replay.*");
	});
});

describe("list", () => {
	it("passes no filter when none was given", async () => {
		// An empty-object filter and an absent one can mean different things to
		// a store. Sending only what the user asked for keeps the default query
		// unconstrained.
		const service = fakeService();
		await run(["list"], { service });
		expect(service.listArgs[0]).toEqual({});
	});

	it("accepts the error filter under either spelling", async () => {
		// `--error` is the ergonomic form and `--errorId` the explicit one; a
		// user who reached for the wrong one would otherwise get an unfiltered
		// list that looks like "no such error".
		for (const flags of [{ error: "err-9" }, { errorId: "err-9" }]) {
			const service = fakeService();
			await run(["list"], { flags, service });
			expect(service.listArgs[0]).toEqual({ errorId: "err-9" });
		}
	});

	it("accepts the trail filter under either spelling, and both filters together", async () => {
		for (const flags of [{ trail: "trail-9" }, { trailId: "trail-9" }]) {
			const service = fakeService();
			await run(["list"], { flags, service });
			expect(service.listArgs[0]).toEqual({ trailId: "trail-9" });
		}
		const service = fakeService();
		await run(["list"], {
			flags: { error: "err-9", trail: "trail-9" },
			service,
		});
		expect(service.listArgs[0]).toEqual({
			errorId: "err-9",
			trailId: "trail-9",
		});
	});

	it("ignores a non-string filter rather than passing it through", async () => {
		// A flag parsed as a boolean — `--error` with no value — must not become
		// a filter for the literal `true`, which would return nothing and read
		// as "that error has no captures".
		const service = fakeService();
		await run(["list"], { flags: { error: true, trail: 7 }, service });
		expect(service.listArgs[0]).toEqual({});
	});

	it("projects each session down to what a terminal can show", async () => {
		// The stored session carries chunk payloads. Listing them would flood a
		// terminal; the projection is what makes `list` usable at all.
		const sessions = (
			(await run(["list"], { service: fakeService() })).data as {
				sessions: Array<Record<string, unknown>>;
			}
		).sessions;
		expect(sessions[0]).toEqual({
			id: "session-1",
			status: "closed",
			errorId: "err-1",
			trailId: "trail-1",
			flags: ["flag-a"],
			chunkCount: 3,
			totalBytes: 2048,
			summary: "3 chunks, 2 KiB",
		});
	});

	it("reports the count and the station it counted at", async () => {
		// A count with no station is ambiguous on a machine with several.
		const result = await run(["list"], {
			flags: { station: "station:a" },
			service: fakeService(),
		});
		expect(result.message).toContain("1 session(s)");
		expect(result.message).toContain("station:a");
		expect(progress.join(" ")).toContain("1 session(s)");
	});

	it("succeeds with an empty list rather than refusing", async () => {
		// No captures is a normal state — capture may simply be off, or nothing
		// has failed yet. A refusal would read as a broken store.
		const result = await run(["list"], {
			service: fakeService({ list: async () => [] }),
		});
		expect(result.ok).toBe(true);
		expect((result.data as { sessions: unknown[] }).sessions).toEqual([]);
	});
});

describe("session id requirement", () => {
	it("refuses get, open, and summarize without an id", async () => {
		// These three name a specific capture. Defaulting to "the latest" would
		// make a mistyped command quietly operate on the wrong session.
		for (const sub of ["get", "open", "summarize"]) {
			const result = await run([sub], { service: fakeService() });
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_REPLAY_USAGE");
			expect(result.message).toContain(`hobo replay ${sub}`);
			expect((result.remediation ?? []).join(" ")).toContain(
				`hobo replay ${sub} <sessionId>`,
			);
		}
	});

	it("refuses an empty id as firmly as a missing one", async () => {
		// A shell expanding an unset variable produces exactly this.
		const result = await run(["get", ""], { service: fakeService() });
		expect(result.code).toBe("HOBO_REPLAY_USAGE");
	});

	it("does not require an id for list, retention, or doctor", async () => {
		for (const sub of ["list", "retention", "doctor"]) {
			expect((await run([sub], { service: fakeService() })).ok).toBe(true);
		}
	});
});

describe("get", () => {
	it("returns the whole session when it exists", async () => {
		const result = await run(["get", "session-1"], { service: fakeService() });
		expect(result.ok).toBe(true);
		expect(result.code).toBe("HOBO_REPLAY_GET");
		expect((result.data as { session: { id: string } }).session.id).toBe(
			"session-1",
		);
	});

	it("refuses a session that is not there, echoing the id", async () => {
		// A typo and a capture pruned by retention need different fixes, and the
		// echoed id is what lets the user tell which happened.
		const result = await run(["get", "session-404"], {
			service: fakeService({ get: async () => null }),
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_REPLAY_NOT_FOUND");
		expect(result.message).toContain("session-404");
	});
});

describe("summarize", () => {
	it("puts the summary in the message, the data, and the progress stream", async () => {
		// The summary is the entire product of the command. A user piping to
		// `jq`, one reading the terminal, and one watching progress should all
		// get it without a second call.
		const result = await run(["summarize", "session-1"], {
			service: fakeService(),
		});
		expect(result.message).toBe("session-1: 3 chunks");
		expect((result.data as { summary: string }).summary).toBe(
			"session-1: 3 chunks",
		);
		expect(progress).toContain("session-1: 3 chunks");
	});

	it("refuses a session with no summary to give", async () => {
		const result = await run(["summarize", "gone"], {
			service: fakeService({ summarize: async () => null }),
		});
		expect(result.code).toBe("HOBO_REPLAY_NOT_FOUND");
		expect(result.message).toContain("gone");
	});
});

describe("open", () => {
	it("returns the deep link and event count without the events", async () => {
		// The event array is the bulk of a replay. Inlining it would make the
		// envelope unusable in a terminal, so the omission is stated rather than
		// left to look like an empty capture.
		const result = await run(["open", "session-1"], { service: fakeService() });
		expect(result.ok).toBe(true);
		const data = result.data as {
			deepLink: string;
			openUi: boolean;
			eventCount: number;
			eventsOmitted: boolean;
		};
		expect(data.deepLink).toBe("hobo://replay/session-1");
		expect(data.openUi).toBe(false);
		expect(data.eventCount).toBe(2);
		expect(data.eventsOmitted).toBe(true);
	});

	it("surfaces the service's own refusal code rather than a generic one", async () => {
		// The service knows *why* it would not open — policy, PAM gate, corrupt
		// chunk. Flattening that to one code would leave the user with no next
		// step for three unrelated problems.
		const result = await run(["open", "session-1"], {
			service: fakeService({
				open: async () => ({
					ok: false,
					code: "HOBO_REPLAY_POLICY_DENIED",
					message: "PAM gate denied open",
				}),
			} as Partial<ReplayService>),
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_REPLAY_POLICY_DENIED");
		expect(result.message).toBe("PAM gate denied open");
		expect((result.data as { sessionId: string }).sessionId).toBe("session-1");
	});
});

describe("retention", () => {
	it("reports scanned, erased, and retained, and names the recipe", async () => {
		// Erasure is irreversible. All three counts have to add up in the output
		// or an operator cannot tell a working sweep from one that erased
		// everything it looked at.
		const result = await run(["retention"], { service: fakeService() });
		expect(result.ok).toBe(true);
		const data = result.data as {
			scanned: number;
			erased: number;
			retained: number;
			recipe: string;
		};
		expect(data).toMatchObject({
			scanned: 5,
			erased: 2,
			retained: 3,
			recipe: "replay.retention",
		});
		expect(result.message).toContain("erased 2 of 5");
		expect(progress.join(" ")).toContain("scanned=5 erased=2");
	});
});
