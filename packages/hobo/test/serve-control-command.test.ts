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
		expect(createServeControlCommand().implemented).toBe(true);
	});
});

describe("target selection", () => {
	it("serves the control plane", async () => {
		const { result } = await serve(["control"]);
		expect(result.ok).toBe(true);
	});

	it("defaults to control when no target is given", async () => {
		const { result } = await serve([]);
		expect(result.ok).toBe(true);
	});

	it("refuses an unknown target", async () => {
		const { result } = await serve(["dashboard"]);
		expect(result.ok).toBe(false);
	});

	it("names the target it did not recognise", async () => {
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
		const dir = home();
		const { lines } = await serve(["control"], { hoboHome: dir });
		expect(lines[0]).toContain(`HOBO_HOME=${dir}`);
	});

	it("advertises the yard, stream, world and otlp routes", async () => {
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
		const { lines } = await serve(["control"], { demo: true });
		expect(lines[0]).toContain("demo=on");
	});

	it("prints the seed the simulator actually used", async () => {
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
		const { result } = await serve(["control"]);
		expect((result.data as Record<string, unknown>).port).toBeGreaterThan(0);
	});

	it("returns the home so a caller can confirm the yard", async () => {
		const dir = home();
		const { result } = await serve(["control"], { hoboHome: dir });
		expect((result.data as Record<string, unknown>).hoboHome).toBe(dir);
	});

	it("says it bound rather than that it is serving", async () => {
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
		const { result } = await serve(["control"], {
			port: undefined,
			flags: { port: 0 },
			env: { HOBO_CONTROL_PORT: "65000" },
		});
		expect((result.data as Record<string, unknown>).port).not.toBe(65_000);
	});

	it("prefers the injected dependency over both", async () => {
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
		await new Promise((resolve) => setImmediate(resolve));
		process.emit(signal as never);
		const result = await running;
		expect(result.ok).toBe(true);
		expect(String(result.message)).toContain("stopped");
	});

	it("still reports the url it had been serving", async () => {
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
