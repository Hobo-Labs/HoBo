/**
 * `hobo serve control` — the local control-plane HTTP+SSE listener.
 *
 * The command itself is thin: it resolves four settings and hands them to
 * `createControlApiServer`. Thin does not mean low-risk, because each of those
 * resolutions has a failure mode that shows up as something other than an
 * error:
 *
 * - **host** defaults to `127.0.0.1`. A default of `0.0.0.0` would expose the
 *   whole management surface — the same surface as the CLI and MCP — to the
 *   local network, and nothing about a successful bind would say so.
 * - **port** takes a flag, then the environment, then 8790, and falls back to
 *   8790 again if what it got is not a number. `Number("http")` is `NaN`, and
 *   an unguarded `NaN` binds an arbitrary ephemeral port, so the operator's
 *   bookmark quietly stops working.
 * - **hoboHome** decides which Yard the UI is looking at. Reading the wrong one
 *   shows an empty, healthy-looking yard rather than an error.
 * - **demo** feeds the world model from a simulator. If demo mode were not
 *   visible in the startup line, an operator could mistake simulated occupancy
 *   for their real one.
 *
 * Every test here uses `once: true` and port 0 so the process binds an
 * ephemeral port and closes immediately — a serve command that held the port
 * would hang the suite, and one that bound 8790 for real would collide with a
 * developer's own running server.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createServeControlCommand } from "../src/serve-control-command.js";

const temps: string[] = [];

afterEach(() => {
	for (const dir of temps.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-serve-control-"));
	temps.push(dir);
	return dir;
}

/**
 * Run the command against an ephemeral port, capturing the startup line.
 *
 * `port: 0` is passed as a dep rather than a flag on purpose for the tests that
 * are not about port resolution: it keeps them from racing a real 8790.
 */
async function serve(
	args: readonly string[],
	options: {
		readonly flags?: Record<string, unknown>;
		readonly env?: NodeJS.ProcessEnv;
		readonly hoboHome?: string;
		readonly port?: number;
		readonly host?: string;
		readonly demo?: boolean;
		readonly demoSeed?: number;
	} = {},
) {
	const lines: string[] = [];
	const command = createServeControlCommand({
		hoboHome: options.hoboHome ?? home(),
		env: options.env ?? {},
		once: true,
		log: (line) => lines.push(line),
		...(options.port === undefined ? { port: 0 } : { port: options.port }),
		...(options.host === undefined ? {} : { host: options.host }),
		...(options.demo === undefined ? {} : { demo: options.demo }),
		...(options.demoSeed === undefined ? {} : { demoSeed: options.demoSeed }),
	});
	const result = (await command.run({
		args,
		flags: options.flags ?? {},
	} as never)) as Record<string, unknown>;
	return { result, lines };
}

describe("the command module", () => {
	it("declares itself implemented", () => {
		// The CLI renders unimplemented modules as a stub notice; a false here
		// would hide a working server behind "not implemented yet".
		expect(createServeControlCommand().implemented).toBe(true);
	});
});

describe("target selection", () => {
	it("serves the control plane", async () => {
		const { result } = await serve(["control"]);
		expect(result.ok).toBe(true);
	});

	it("defaults to control when no target is given", async () => {
		// `hobo serve` with nothing after it is the shortest thing an operator
		// types; making it an error would be a worse default than picking the one
		// target that exists.
		const { result } = await serve([]);
		expect(result.ok).toBe(true);
	});

	it("refuses an unknown target", async () => {
		const { result } = await serve(["dashboard"]);
		expect(result.ok).toBe(false);
	});

	it("names the target it did not recognise", async () => {
		// Without the echo, a typo and a removed target look identical.
		const { result } = await serve(["dashboard"]);
		expect(String(result.message)).toContain("dashboard");
	});

	it("lists the supported targets when refusing", async () => {
		const { result } = await serve(["dashboard"]);
		expect(String(result.message)).toContain("supported: control");
	});

	it("prints a usage line an operator can copy", async () => {
		const { result } = await serve(["dashboard"]);
		expect(String((result.data as Record<string, unknown>).usage)).toContain(
			"hobo serve control",
		);
	});

	it("does not bind anything when it refuses", async () => {
		// A refusal that had already opened a socket would leak a listener.
		const { lines } = await serve(["dashboard"]);
		expect(lines).toEqual([]);
	});
});

describe("the startup line", () => {
	it("prints the url the operator should open", async () => {
		const { lines } = await serve(["control"]);
		expect(lines[0]).toMatch(/hobo serve control: http:\/\/127\.0\.0\.1:\d+/u);
	});

	it("prints the home it is serving", async () => {
		// Which Yard the UI shows is the single most confusable thing here; an
		// empty yard from the wrong home looks exactly like a healthy empty one.
		const dir = home();
		const { lines } = await serve(["control"], { hoboHome: dir });
		expect(lines[0]).toContain(`HOBO_HOME=${dir}`);
	});

	it("advertises the yard, stream, world and otlp routes", async () => {
		// These are the endpoints the game UI and the collector attach to; the
		// startup line is the only place they are enumerated.
		const { lines } = await serve(["control"]);
		for (const route of [
			"/v1/yard/snapshot",
			"/v1/yard/stream",
			"/v1/world/snapshot",
			"/v1/otlp",
		]) {
			expect(lines[0]).toContain(route);
		}
	});

	it("says nothing about demo mode when demo is off", async () => {
		const { lines } = await serve(["control"]);
		expect(lines[0]).not.toContain("demo=");
	});

	it("says demo is on when it is", async () => {
		// Simulated occupancy that is not labelled as simulated is the one
		// outcome here that could mislead an operator about their real yard.
		const { lines } = await serve(["control"], { demo: true });
		expect(lines[0]).toContain("demo=on");
	});

	it("prints the seed the simulator actually used", async () => {
		// The seed is what makes a demo reproducible; printing the requested one
		// rather than the server's would lie whenever they differ.
		const { lines } = await serve(["control"], { demo: true, demoSeed: 42 });
		expect(lines[0]).toContain("seed=42");
	});
});

describe("bind result", () => {
	it("returns the bound url", async () => {
		const { result } = await serve(["control"]);
		expect(String((result.data as Record<string, unknown>).url)).toContain(
			"http://",
		);
	});

	it("returns the port that was actually bound, not the one requested", async () => {
		// With port 0 the kernel picks; reporting 0 back would be useless to a
		// caller trying to connect.
		const { result } = await serve(["control"]);
		expect((result.data as Record<string, unknown>).port).toBeGreaterThan(0);
	});

	it("returns the home so a caller can confirm the yard", async () => {
		const dir = home();
		const { result } = await serve(["control"], { hoboHome: dir });
		expect((result.data as Record<string, unknown>).hoboHome).toBe(dir);
	});

	it("says it bound rather than that it is serving", async () => {
		// `once` closed the listener; claiming it is serving would be false.
		const { result } = await serve(["control"]);
		expect(String(result.message)).toContain("bound");
	});
});

describe("port resolution", () => {
	it("takes a numeric port flag", async () => {
		const { result } = await serve(["control"], {
			port: undefined,
			flags: { port: 0 },
		});
		expect(result.ok).toBe(true);
	});

	it("accepts a port given as a string", async () => {
		// Every shell hands flags over as strings; only a parsed flags layer
		// would ever produce a number here, and the command cannot assume one.
		const { result } = await serve(["control"], {
			port: undefined,
			flags: { port: "0" },
		});
		expect(result.ok).toBe(true);
	});

	it("falls back to the environment when no flag is given", async () => {
		const { result } = await serve(["control"], {
			port: undefined,
			env: { HOBO_CONTROL_PORT: "0" },
		});
		expect(result.ok).toBe(true);
	});

	it("prefers the flag over the environment", async () => {
		// The environment is ambient and often set by a forgotten shell profile;
		// the flag is the deliberate one.
		const { result } = await serve(["control"], {
			port: undefined,
			flags: { port: 0 },
			env: { HOBO_CONTROL_PORT: "65000" },
		});
		expect((result.data as Record<string, unknown>).port).not.toBe(65_000);
	});

	it("prefers the injected dependency over both", async () => {
		// The composition root wins; otherwise an embedding host could not pin
		// the port it already reserved.
		const { result } = await serve(["control"], {
			port: 0,
			flags: { port: 65_001 },
			env: { HOBO_CONTROL_PORT: "65002" },
		});
		expect((result.data as Record<string, unknown>).port).not.toBe(65_001);
	});
});

describe("host resolution", () => {
	it("binds loopback by default", async () => {
		// The default must not expose the management surface to the network.
		const { lines } = await serve(["control"]);
		expect(lines[0]).toContain("127.0.0.1");
	});

	it("takes an explicit host flag", async () => {
		const { result } = await serve(["control"], {
			flags: { host: "localhost" },
		});
		expect(result.ok).toBe(true);
	});

	it("ignores a non-string host rather than binding something odd", async () => {
		const { lines } = await serve(["control"], { flags: { host: 7 } });
		expect(lines[0]).toContain("127.0.0.1");
	});
});

describe("home resolution", () => {
	it("prefers the injected dependency", async () => {
		const dir = home();
		const { result } = await serve(["control"], {
			hoboHome: dir,
			flags: { home: "/nonexistent/elsewhere" },
			env: { HOBO_HOME: "/nonexistent/env" },
		});
		expect((result.data as Record<string, unknown>).hoboHome).toBe(dir);
	});

	it("falls back to the --home flag", async () => {
		const dir = home();
		const command = createServeControlCommand({
			env: {},
			port: 0,
			once: true,
			log: () => {},
		});
		const result = (await command.run({
			args: ["control"],
			flags: { home: dir },
		} as never)) as Record<string, unknown>;
		expect((result.data as Record<string, unknown>).hoboHome).toBe(dir);
	});

	it("ignores an empty --home rather than treating it as a path", async () => {
		// An empty string resolves to the process cwd for most path APIs — here,
		// the repository, which is exactly where nothing should be written.
		const dir = home();
		const command = createServeControlCommand({
			env: { HOBO_HOME: dir },
			port: 0,
			once: true,
			log: () => {},
		});
		const result = (await command.run({
			args: ["control"],
			flags: { home: "" },
		} as never)) as Record<string, unknown>;
		expect((result.data as Record<string, unknown>).hoboHome).toBe(dir);
	});

	it("falls back to the environment when no flag is given", async () => {
		const dir = home();
		const command = createServeControlCommand({
			env: { HOBO_HOME: dir },
			port: 0,
			once: true,
			log: () => {},
		});
		const result = (await command.run({
			args: ["control"],
			flags: {},
		} as never)) as Record<string, unknown>;
		expect((result.data as Record<string, unknown>).hoboHome).toBe(dir);
	});
});

describe("ambient defaults", () => {
	// The composed binary injects nothing but the runtime, so the fallbacks to
	// the real process environment and to stderr are the paths that actually
	// run in production — the injected ones exist for tests and embedders.

	it("reads the real process environment when none is injected", async () => {
		const previous = process.env.HOBO_CONTROL_DEMO;
		process.env.HOBO_CONTROL_DEMO = "1";
		try {
			const lines: string[] = [];
			const command = createServeControlCommand({
				hoboHome: home(),
				port: 0,
				once: true,
				log: (line) => lines.push(line),
			});
			await command.run({ args: ["control"], flags: {} } as never);
			expect(lines[0]).toContain("demo=on");
		} finally {
			if (previous === undefined) delete process.env.HOBO_CONTROL_DEMO;
			else process.env.HOBO_CONTROL_DEMO = previous;
		}
	});

	it("logs to stderr when no logger is injected", async () => {
		// stdout is reserved for machine-readable output; a startup banner there
		// would corrupt anything piping `--json`.
		const original = console.error;
		const seen: unknown[] = [];
		console.error = (...args: unknown[]) => {
			seen.push(args[0]);
		};
		try {
			await createServeControlCommand({
				hoboHome: home(),
				env: {},
				port: 0,
				once: true,
			}).run({ args: ["control"], flags: {} } as never);
		} finally {
			console.error = original;
		}
		expect(String(seen[0])).toContain("hobo serve control:");
	});
});

describe("holding the process open", () => {
	// Without `once`, the command deliberately never resolves until a signal
	// arrives — that is what makes `hobo serve control` a foreground server
	// rather than a command that binds and exits. The risk is the mirror image:
	// a listener that ignores the signal leaves an operator with a Ctrl-C that
	// does nothing and a port still held after the terminal is gone.
	it.each([
		"SIGINT",
		"SIGTERM",
	] as const)("stops on %s and reports it stopped", async (signal) => {
		const command = createServeControlCommand({
			hoboHome: home(),
			env: {},
			port: 0,
			log: () => {},
		});
		const running = command.run({
			args: ["control"],
			flags: {},
		} as never) as Promise<Record<string, unknown>>;
		// Yield until the bind has happened and the handler is registered;
		// signalling earlier would be delivered to nobody and hang the test.
		await new Promise((resolve) => setImmediate(resolve));
		process.emit(signal as never);
		const result = await running;
		expect(result.ok).toBe(true);
		expect(String(result.message)).toContain("stopped");
	});

	it("still reports the url it had been serving", async () => {
		// The closeout line is the operator's record of what just went away.
		const command = createServeControlCommand({
			hoboHome: home(),
			env: {},
			port: 0,
			log: () => {},
		});
		const running = command.run({
			args: ["control"],
			flags: {},
		} as never) as Promise<Record<string, unknown>>;
		await new Promise((resolve) => setImmediate(resolve));
		process.emit("SIGINT" as never);
		const result = await running;
		expect(String((result.data as Record<string, unknown>).url)).toContain(
			"http://",
		);
	});
});

describe("demo mode", () => {
	it("is off unless asked for", async () => {
		// Demo mode replaces the world read model with a simulation; defaulting
		// it on would show an operator a yard that does not exist.
		const { lines } = await serve(["control"], { env: {} });
		expect(lines[0]).not.toContain("demo=on");
	});

	it("turns on with the --demo flag", async () => {
		const { lines } = await serve(["control"], { flags: { demo: true } });
		expect(lines[0]).toContain("demo=on");
	});

	it("turns on with the environment variable", async () => {
		const { lines } = await serve(["control"], {
			env: { HOBO_CONTROL_DEMO: "1" },
		});
		expect(lines[0]).toContain("demo=on");
	});

	it("requires exactly 1 in the environment, not any truthy string", async () => {
		// `HOBO_CONTROL_DEMO=0` and `=false` both read as "off" to a human; a
		// non-empty-string check would read both as on.
		const { lines } = await serve(["control"], {
			env: { HOBO_CONTROL_DEMO: "0" },
		});
		expect(lines[0]).not.toContain("demo=on");
	});

	it("requires the flag to be true, not merely present", async () => {
		const { lines } = await serve(["control"], { flags: { demo: "yes" } });
		expect(lines[0]).not.toContain("demo=on");
	});

	it("takes the seed from the flag", async () => {
		const { lines } = await serve(["control"], {
			flags: { demo: true, demoSeed: "7" },
		});
		expect(lines[0]).toContain("seed=7");
	});

	it("takes the seed from the environment when no flag is given", async () => {
		const { lines } = await serve(["control"], {
			flags: { demo: true },
			env: { HOBO_CONTROL_DEMO_SEED: "11" },
		});
		expect(lines[0]).toContain("seed=11");
	});

	it("prefers the flag seed over the environment", async () => {
		const { lines } = await serve(["control"], {
			flags: { demo: true, demoSeed: "7" },
			env: { HOBO_CONTROL_DEMO_SEED: "11" },
		});
		expect(lines[0]).toContain("seed=7");
	});

	it("ignores a non-numeric seed flag rather than seeding with NaN", async () => {
		// A NaN seed would make the "deterministic" simulator non-reproducible
		// while still reporting a seed.
		const { lines } = await serve(["control"], {
			flags: { demo: true, demoSeed: "banana" },
			env: { HOBO_CONTROL_DEMO_SEED: "11" },
		});
		expect(lines[0]).toContain("seed=11");
	});

	it("still runs with no seed anywhere", async () => {
		const { result } = await serve(["control"], { flags: { demo: true } });
		expect(result.ok).toBe(true);
	});
});
