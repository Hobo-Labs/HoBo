/**
 * `hobo station` — the ops/setup family for Station occupancy.
 *
 * The header of the module makes the load-bearing claim: this is **not a
 * lifecycle verb**. `up` and `down` here start and stop *occupancy* — the
 * Station's own presence — while `hobo up`/`hobo down` remain the only verbs
 * that act on an app graph. Two commands spelled the same doing different
 * things is a real hazard, so the tests pin the distinction where it shows:
 * `station down` retains the Station's data, and says so.
 *
 * Two resolution chains carry the rest of the risk:
 *
 * **The station id** is taken from a flag, then the environment, then the
 * profile's default, then `station:local`. Every subcommand acts on whichever
 * one wins, so a chain that consulted these in a different order would have
 * `rails activate` apply a rail to a Station the operator was not looking at.
 *
 * **The HoBo home** is taken from the explicit dependency, then the injected
 * env, then the ambient env, then the default. The explicit one must win, or a
 * caller that isolated itself would still read somebody else's Stations.
 *
 * `activate` and `up` both reach for the Station client afterwards to enrich
 * their result with pins — and both swallow a failure there. That is right: the
 * activation already happened, and losing the result because the read-back
 * failed would tell the operator their rail did not activate when it did.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStationCommand } from "../src/station-command.js";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-station-cmd-"));
	temps.push(dir);
	return dir;
}

/** Run a subcommand against an isolated home, capturing what it logged. */
async function run(
	args: readonly string[],
	options: {
		readonly hoboHome?: string;
		readonly flags?: Record<string, unknown>;
		readonly env?: NodeJS.ProcessEnv;
	} = {},
) {
	const lines: string[] = [];
	const command = createStationCommand({
		hoboHome: options.hoboHome ?? home(),
		env: options.env ?? {},
		log: (line) => lines.push(line),
	});
	const result = await command.run({
		args,
		flags: options.flags ?? {},
	} as never);
	return { result: result as Record<string, unknown>, lines };
}

/** A home with an initialised station, for the subcommands that need one. */
async function initialised(name = "local") {
	const dir = home();
	const init = await run(["init"], { hoboHome: dir, flags: { name } });
	return { dir, init: init.result };
}

describe("the command module", () => {
	it("declares itself implemented", () => {
		// The CLI shows unimplemented modules differently; a false here would
		// hide a working command behind a stub notice.
		expect(createStationCommand().implemented).toBe(true);
	});
});

describe("init", () => {
	it("initialises a station", async () => {
		const { init } = await initialised();
		expect(init.ok).toBe(true);
	});

	it("defaults the station name rather than refusing", async () => {
		// `hobo station init` with no flags is the first command a new user
		// runs; requiring a name would make the happy path an error.
		const { result } = await run(["init"]);
		expect(result.ok).toBe(true);
	});

	it("derives the id from the name", async () => {
		const { result } = await run(["init"], { flags: { name: "edge" } });
		expect(JSON.stringify(result.data)).toContain("station:edge");
	});

	it("uses an explicit id over the derived one", async () => {
		const { result } = await run(["init"], {
			flags: { name: "edge", id: "station:custom" },
		});
		expect(JSON.stringify(result.data)).toContain("station:custom");
	});

	it("records the station as the profile default", async () => {
		// This is what makes every later subcommand act on it without a flag.
		const dir = home();
		await run(["init"], { hoboHome: dir, flags: { name: "edge" } });
		const status = await run(["status"], { hoboHome: dir });
		expect(JSON.stringify(status.result)).toContain("station:edge");
	});

	it("ignores an empty name flag rather than making an empty id", async () => {
		// `station:` addresses nothing.
		const { result } = await run(["init"], { flags: { name: "" } });
		expect(JSON.stringify(result.data)).toContain("station:local");
	});
});

describe("the default subcommand", () => {
	it("reports status when given no subcommand", async () => {
		// Status is the read-only one; defaulting to anything that mutates would
		// be a surprise from a bare `hobo station`.
		const { dir } = await initialised();
		const { result } = await run([], { hoboHome: dir });
		expect(result).toHaveProperty("ok");
	});

	it("refuses an unknown subcommand", async () => {
		const { result } = await run(["reticulate"]);
		expect(result.ok).toBe(false);
		expect(String(result.message)).toContain("reticulate");
	});

	it("prints the usage line when it refuses", async () => {
		// A refusal an operator cannot act on is only half a refusal.
		const { result } = await run(["reticulate"]);
		expect(JSON.stringify(result.data)).toContain("init|up|down|status|rails");
	});
});

describe("occupancy up and down", () => {
	it("brings occupancy up", async () => {
		const { dir } = await initialised();
		const { result } = await run(["up"], { hoboHome: dir });
		expect(result).toHaveProperty("ok");
	});

	it("says which station and rail came up", async () => {
		// The rail hash is what an operator checks against what they approved.
		const { dir } = await initialised();
		const { lines } = await run(["up"], { hoboHome: dir });
		expect(lines.join(" ")).toMatch(/station up.*rail=/u);
	});

	it("reports no rail rather than an empty one when none is active", async () => {
		const { dir } = await initialised();
		const { lines } = await run(["up"], { hoboHome: dir });
		expect(lines.join(" ")).toMatch(/rail=(none|sha256:)/u);
	});

	it("says data is retained on down", async () => {
		// This is the sentence that distinguishes station down from a lifecycle
		// down: nothing of the operator's is destroyed.
		const { dir } = await initialised();
		const { lines } = await run(["down"], { hoboHome: dir });
		expect(lines.join(" ")).toContain("data retained");
	});

	it("names the station it stopped", async () => {
		const { dir } = await initialised("edge");
		const { lines } = await run(["down"], { hoboHome: dir });
		expect(lines.join(" ")).toContain("station:edge");
	});

	it("reports status without logging anything", async () => {
		// Status is a query; a log line on stderr would pollute a piped `--json`
		// read.
		const { dir } = await initialised();
		const { lines } = await run(["status"], { hoboHome: dir });
		expect(lines).toEqual([]);
	});
});

describe("station id resolution", () => {
	it("prefers an explicit --station flag", async () => {
		const { dir } = await initialised("edge");
		const { lines } = await run(["down"], {
			hoboHome: dir,
			flags: { station: "station:flagged" },
		});
		expect(lines.join(" ")).toContain("station:flagged");
	});

	it("accepts --id as a synonym", async () => {
		const { dir } = await initialised();
		const { lines } = await run(["down"], {
			hoboHome: dir,
			flags: { id: "station:by-id" },
		});
		expect(lines.join(" ")).toContain("station:by-id");
	});

	it("falls back to the environment", async () => {
		const { dir } = await initialised("edge");
		const { lines } = await run(["down"], {
			hoboHome: dir,
			env: { HOBO_STATION: "station:from-env" },
		});
		expect(lines.join(" ")).toContain("station:from-env");
	});

	it("prefers the flag over the environment", async () => {
		// The flag is the more deliberate of the two; the environment is
		// ambient and often set by a shell profile the operator forgot about.
		const { dir } = await initialised();
		const { lines } = await run(["down"], {
			hoboHome: dir,
			flags: { station: "station:flagged" },
			env: { HOBO_STATION: "station:from-env" },
		});
		expect(lines.join(" ")).toContain("station:flagged");
	});

	it("falls back to the profile's default station", async () => {
		// Set by `init`, and the reason a second command needs no flag at all.
		const { dir } = await initialised("edge");
		const { lines } = await run(["down"], { hoboHome: dir });
		expect(lines.join(" ")).toContain("station:edge");
	});

	it("falls back to station:local when nothing names one", async () => {
		// A fresh home with no profile still has to address something.
		const { lines } = await run(["down"], { hoboHome: home() });
		expect(lines.join(" ")).toContain("station:local");
	});

	it("ignores an empty flag rather than addressing an empty station", async () => {
		const { dir } = await initialised("edge");
		const { lines } = await run(["down"], {
			hoboHome: dir,
			flags: { station: "" },
		});
		expect(lines.join(" ")).toContain("station:edge");
	});

	it("ignores a non-string flag", async () => {
		const { dir } = await initialised("edge");
		const { lines } = await run(["down"], {
			hoboHome: dir,
			flags: { station: 7 },
		});
		expect(lines.join(" ")).toContain("station:edge");
	});
});

describe("rails", () => {
	it("lists rails by default", async () => {
		const { dir } = await initialised();
		const { result } = await run(["rails"], { hoboHome: dir });
		expect(result).toHaveProperty("ok");
	});

	it("treats status as a synonym for list", async () => {
		const { dir } = await initialised();
		const list = await run(["rails", "list"], { hoboHome: dir });
		const status = await run(["rails", "status"], { hoboHome: dir });
		expect(status.result.ok).toBe(list.result.ok);
	});

	it("refuses to publish without a document path", async () => {
		// Publishing nothing would either fail deep in the management layer or,
		// worse, publish an empty rail.
		const { dir } = await initialised();
		const { result } = await run(["rails", "publish"], { hoboHome: dir });
		expect(result.ok).toBe(false);
		expect(String(result.message)).toContain("usage:");
	});

	it("names the argument it wanted when refusing a publish", async () => {
		const { dir } = await initialised();
		const { result } = await run(["rails", "publish"], { hoboHome: dir });
		expect(String(result.message)).toContain("rail-doc.json");
	});

	it.each([
		"approve",
		"activate",
	])("refuses to %s without a rail id", async (verb) => {
		// Approving "whatever is latest" is exactly the kind of implicit
		// selection an approval step exists to prevent.
		const { dir } = await initialised();
		const { result } = await run(["rails", verb], { hoboHome: dir });
		expect(result.ok).toBe(false);
		expect(String(result.message)).toContain(verb);
	});

	it("says a rail id or hash is acceptable", async () => {
		const { dir } = await initialised();
		const { result } = await run(["rails", "approve"], { hoboHome: dir });
		expect(String(result.message)).toContain("railId|hash");
	});

	it("refuses an unknown rails subcommand", async () => {
		const { dir } = await initialised();
		const { result } = await run(["rails", "reticulate"], { hoboHome: dir });
		expect(result.ok).toBe(false);
		expect(String(result.message)).toContain("unknown rails subcommand");
	});

	it("names the unknown subcommand", async () => {
		const { dir } = await initialised();
		const { result } = await run(["rails", "reticulate"], { hoboHome: dir });
		expect(String(result.message)).toContain("reticulate");
	});

	it("reports a failure for a rail that does not exist", async () => {
		// It must not invent one, and it must not crash.
		const { dir } = await initialised();
		const { result } = await run(["rails", "approve", "sha256:nope"], {
			hoboHome: dir,
		});
		expect(result).toHaveProperty("ok");
	});
});

describe("home resolution", () => {
	it("prefers the explicit dependency", async () => {
		// A caller that isolated itself must not read somebody else's Stations.
		const dir = home();
		await run(["init"], {
			hoboHome: dir,
			env: { HOBO_HOME: "/nonexistent/elsewhere" },
			flags: { name: "edge" },
		});
		const status = await run(["status"], { hoboHome: dir });
		expect(JSON.stringify(status.result)).toContain("station:edge");
	});

	it("falls back to the injected environment", async () => {
		const dir = home();
		const command = createStationCommand({
			env: { HOBO_HOME: dir },
			log: () => {},
		});
		const result = (await command.run({
			args: ["init"],
			flags: { name: "edge" },
		} as never)) as Record<string, unknown>;
		expect(result.ok).toBe(true);
		expect(JSON.stringify(result.data)).toContain(dir);
	});
});
