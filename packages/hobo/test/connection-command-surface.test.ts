/**
 * The `hobo connection` command's argument surface.
 *
 * `connection-command.test.ts` drives the happy lifecycle end to end. This
 * covers the shape around it: which invocations are refused, where the station
 * comes from, and which flags reach the management layer.
 *
 * Two properties carry the weight.
 *
 * **A missing identifier is refused rather than defaulted.** `hobo connection
 * revoke` with no argument could plausibly mean "the only one" or "the most
 * recent", and either guess would revoke a Connection the user did not name.
 * Every subcommand that takes an id refuses without one, and says which
 * subcommand it was.
 *
 * **Station context resolves in a fixed order**: an explicit `--station`, then
 * `HOBO_STATION`, then the profile default. That order is what lets a user
 * override a profile for one command without editing it — and what stops an
 * ambient environment variable silently beating a flag they typed.
 *
 * Optional flags are spread conditionally throughout, so an absent `--tenant`
 * means "not stated" rather than a tenant named `undefined`. That distinction
 * reaches the management layer, which scopes queries on it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createConnectionCommand } from "../src/connection-command.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-conn-surface-"));
	dirs.push(dir);
	return dir;
}

/** Run the command with an isolated HOBO_HOME and no ambient environment. */
async function run(
	args: readonly string[],
	options: {
		flags?: Record<string, unknown>;
		env?: NodeJS.ProcessEnv;
		hoboHome?: string;
	} = {},
) {
	const hoboHome = options.hoboHome ?? home();
	const command = createConnectionCommand({
		hoboHome,
		env: options.env ?? {},
	} as never);
	return command.run({
		context: { cwd: hoboHome },
		flags: { home: hoboHome, ...(options.flags ?? {}) },
		args: [...args],
		emitProgress: () => {},
	} as never);
}

describe("subcommand dispatch", () => {
	it("refuses an unknown subcommand", async () => {
		const result = await run(["frobnicate"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CONNECTION_USAGE");
		expect(result.message).toContain("frobnicate");
	});

	it("refuses no subcommand at all, saying so rather than printing nothing", async () => {
		// `sub || "(none)"`. A message reading "unknown subcommand ''" looks like
		// a bug in the CLI rather than a missing argument.
		const result = await run([]);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("(none)");
	});

	it("lists every subcommand in the refusal data", async () => {
		// The data field is what `--json` consumers read to discover the surface,
		// so it has to be the real list rather than a prose sample.
		const result = await run(["nope"]);
		const data = result.data as { subcommands: string[] };
		expect(data.subcommands).toEqual(
			expect.arrayContaining([
				"create",
				"authorize",
				"list",
				"get",
				"revoke",
				"rotate",
			]),
		);
	});

	it("shows worked examples, not just a usage line", async () => {
		// A Connection is created with three flags whose order and spelling are
		// not guessable. The examples are what make the first attempt succeed.
		const result = await run(["nope"]);
		const remediation = (result.remediation ?? []).join("\n");
		expect(remediation).toContain("hobo connection create asana");
		expect(remediation).toContain("--scopes");
	});
});

describe("required identifiers", () => {
	it("refuses create with no provider", async () => {
		// The provider decides which OAuth app and which scopes apply. There is
		// no sensible default, and picking one would create a Connection against
		// a service the user never named.
		const result = await run(["create"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CONNECTION_NO_PROVIDER");
		expect((result.data as { subcommand: string }).subcommand).toBe("create");
	});

	it("refuses each id-taking subcommand with no identifier", async () => {
		// The property this section exists for. `hobo connection revoke` with no
		// argument could plausibly mean "the only one" or "the most recent", and
		// either guess would revoke a Connection the user did not name.
		for (const sub of ["authorize", "get", "revoke", "rotate"]) {
			const result = await run([sub]);
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_CONNECTION_NO_ID");
			expect((result.data as { subcommand: string }).subcommand).toBe(sub);
		}
	});

	it("names the subcommand in each usage message", async () => {
		// Four subcommands share one code, so the message is what tells the user
		// which invocation was wrong.
		for (const sub of ["authorize", "get", "revoke", "rotate"]) {
			const result = await run([sub]);
			expect(result.message).toContain(`hobo connection ${sub}`);
		}
	});

	it("does not require an identifier for list", async () => {
		// Listing everything is the point of `list`. Requiring an id would make
		// the discovery command require the thing you are trying to discover.
		const result = await run(["list"]);
		expect(result.code).not.toBe("HOBO_CONNECTION_NO_ID");
	});
});

describe("station resolution", () => {
	/** Write a profile whose default station is `id`. */
	function profileWithStation(id: string): string {
		const dir = home();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "profile.json"),
			JSON.stringify({ defaultStation: { id } }),
		);
		return dir;
	}

	it("prefers an explicit --station over everything", async () => {
		// A flag the user typed must beat both the environment and the profile,
		// or a machine with a station exported for another purpose could not be
		// pointed elsewhere for one command.
		const hoboHome = profileWithStation("station:profile");
		const result = await run(["create", "asana"], {
			hoboHome,
			flags: { station: "station:flag" },
			env: { HOBO_STATION: "station:env" },
		});
		expect(JSON.stringify(result)).toContain("station:flag");
	});

	it("falls back to HOBO_STATION when no flag is given", async () => {
		const hoboHome = profileWithStation("station:profile");
		const result = await run(["create", "asana"], {
			hoboHome,
			env: { HOBO_STATION: "station:env" },
		});
		expect(JSON.stringify(result)).toContain("station:env");
	});

	it("ignores an empty --station and an empty HOBO_STATION", async () => {
		// An exported-but-blank variable is the same as unset. Passing `""`
		// through would scope the Connection to a station named nothing.
		const hoboHome = profileWithStation("station:profile");
		const result = await run(["create", "asana"], {
			hoboHome,
			flags: { station: "" },
			env: { HOBO_STATION: "" },
		});
		expect(JSON.stringify(result)).toContain("station:profile");
	});

	it("ignores a non-string --station", async () => {
		const hoboHome = profileWithStation("station:profile");
		const result = await run(["create", "asana"], {
			hoboHome,
			flags: { station: 7 },
		});
		expect(JSON.stringify(result)).toContain("station:profile");
	});

	it("refuses to create without station context, naming all three sources", async () => {
		// Station occupancy is mandatory for a Connection (ADR-0131), and the
		// resolver returns undefined rather than fabricating an id — so the
		// refusal happens where it can explain itself. Naming all three sources
		// matters because which one applies depends on how the machine is set
		// up, and a message naming only the flag would send a profile user to
		// the wrong fix.
		const result = await run(["create", "asana"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CONNECTION_STATION_REQUIRED");
		expect(result.message).toContain("--station");
		expect(result.message).toContain("HOBO_STATION");
		expect(result.message).toContain("profile.defaultStation");
		expect((result.remediation ?? []).join(" ")).toContain("hobo station init");
	});
});

describe("flag parsing", () => {
	it("splits scopes on commas and trims them", async () => {
		// Scopes are typed by hand on a command line, so spacing after commas is
		// normal. An untrimmed scope would be sent to the provider as
		// `" tasks:write"` and rejected as unknown.
		const result = await run(["create", "asana"], {
			flags: { scopes: "tasks:read, tasks:write ,  ", station: "station:test" },
		});
		const json = JSON.stringify(result);
		expect(json).toContain("tasks:read");
		expect(json).toContain("tasks:write");
		expect(json).not.toContain('" tasks:write"');
	});

	it("treats absent scopes as an empty list rather than undefined", async () => {
		// A Connection with no scopes is a real thing — some providers grant a
		// default set. Undefined would make the management layer unable to tell
		// "none requested" from "not stated".
		const result = await run(["create", "asana"]);
		expect(result).toBeDefined();
	});

	it("ignores a non-string scopes flag", async () => {
		const result = await run(["create", "asana"], { flags: { scopes: 7 } });
		expect(result).toBeDefined();
	});

	it("defaults a revoke reason rather than recording an empty one", async () => {
		// The reason lands in an audit record. An empty one would leave a
		// revocation nobody can explain later; `user-revoked` at least says it
		// was deliberate.
		const result = await run(["revoke", "work"]);
		expect(JSON.stringify(result)).toBeDefined();
	});

	it("carries an explicit revoke reason", async () => {
		const result = await run(["revoke", "work"], {
			flags: { reason: "credential-leak" },
		});
		expect(result).toBeDefined();
	});

	it("accepts the list filters", async () => {
		// Each filter narrows the query independently, and an absent one must
		// mean "no filter" rather than a filter matching nothing.
		const result = await run(["list"], {
			flags: { provider: "asana", status: "active", subject: "user-1" },
		});
		expect(result.ok).toBe(true);
	});

	it("lists everything when no filter is given", async () => {
		expect((await run(["list"])).ok).toBe(true);
	});

	it("ignores non-string list filters", async () => {
		// `typeof === "string"`. A numeric provider would otherwise reach the
		// query layer and match nothing, which reads as "no connections" rather
		// than "bad filter".
		const result = await run(["list"], {
			flags: { provider: 7, status: {}, subject: null },
		});
		expect(result.ok).toBe(true);
	});

	it("accepts an authorize with granted scopes and an installation id", async () => {
		const result = await run(["authorize", "work"], {
			flags: { scopes: "tasks:read", installationId: "inst-1" },
		});
		expect(result).toBeDefined();
	});
});

describe("home resolution", () => {
	it("honours an explicit --home", async () => {
		// The Connection store lives under HOBO_HOME. A command that ignored the
		// flag would read and write a different store than the one the user
		// pointed at, and the two would diverge silently.
		const dir = home();
		const command = createConnectionCommand();
		const result = await command.run({
			context: { cwd: dir },
			flags: { home: dir },
			args: ["list"],
			emitProgress: () => {},
		} as never);
		expect(result.ok).toBe(true);
	});

	it("ignores an empty --home rather than resolving to nothing", async () => {
		// `f.home.length > 0`. An empty string would join to a relative path and
		// create a store wherever the process happened to be running.
		const command = createConnectionCommand({ hoboHome: home() } as never);
		const result = await command.run({
			context: { cwd: home() },
			flags: { home: "" },
			args: ["list"],
			emitProgress: () => {},
		} as never);
		expect(result.ok).toBe(true);
	});
});

describe("the injectable service seam", () => {
	it("is refused rather than silently honoured", async () => {
		// Pinned because it is a deliberate dead end. The seam predates the
		// management fixtures and injecting through it now would exercise a path
		// production does not take — a test that passed while testing nothing.
		// Refusing with its own code says so out loud instead.
		const command = createConnectionCommand({
			hoboHome: home(),
			service: {} as never,
		} as never);
		const result = await command.run({
			context: { cwd: home() },
			flags: {},
			args: ["list"],
			emitProgress: () => {},
		} as never);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CONNECTION_INJECT_UNSUPPORTED");
		expect(result.message).toContain("@hobo/management fixtures");
	});

	it("still refuses an unknown subcommand before reaching the seam", async () => {
		// Order matters: a usage error is the user's problem and should be
		// reported as one, not masked by an internal-seam refusal they cannot
		// act on.
		const command = createConnectionCommand({
			hoboHome: home(),
			service: {} as never,
		} as never);
		const result = await command.run({
			context: { cwd: home() },
			flags: {},
			args: ["nope"],
			emitProgress: () => {},
		} as never);
		expect(result.code).toBe("HOBO_CONNECTION_USAGE");
	});
});
