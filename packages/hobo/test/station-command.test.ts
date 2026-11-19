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

async function initialised(name = "local") {
	const dir = home();
	const init = await run(["init"], { hoboHome: dir, flags: { name } });
	return { dir, init: init.result };
}

describe("the command module", () => {
	it("declares itself implemented", () => {
		expect(createStationCommand().implemented).toBe(true);
	});
});

describe("init", () => {
	it("initialises a station", async () => {
		const { init } = await initialised();
		expect(init.ok).toBe(true);
	});

	it("defaults the station name rather than refusing", async () => {
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
		const dir = home();
		await run(["init"], { hoboHome: dir, flags: { name: "edge" } });
		const status = await run(["status"], { hoboHome: dir });
		expect(JSON.stringify(status.result)).toContain("station:edge");
	});

	it("ignores an empty name flag rather than making an empty id", async () => {
		const { result } = await run(["init"], { flags: { name: "" } });
		expect(JSON.stringify(result.data)).toContain("station:local");
	});
});

describe("the default subcommand", () => {
	it("reports status when given no subcommand", async () => {
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
		const { dir } = await initialised();
		const { lines } = await run(["down"], {
			hoboHome: dir,
			flags: { station: "station:flagged" },
			env: { HOBO_STATION: "station:from-env" },
		});
		expect(lines.join(" ")).toContain("station:flagged");
	});

	it("falls back to the profile's default station", async () => {
		const { dir } = await initialised("edge");
		const { lines } = await run(["down"], { hoboHome: dir });
		expect(lines.join(" ")).toContain("station:edge");
	});

	it("falls back to station:local when nothing names one", async () => {
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
		const { dir } = await initialised();
		const { result } = await run(["rails", "approve", "sha256:nope"], {
			hoboHome: dir,
		});
		expect(result).toHaveProperty("ok");
	});
});

describe("home resolution", () => {
	it("prefers the explicit dependency", async () => {
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
