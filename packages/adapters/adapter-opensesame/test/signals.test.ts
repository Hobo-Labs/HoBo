import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpenSesameAdapterError } from "../src/errors.js";
import {
	type RunInput,
	runProxied,
	type SpawnedProcess,
} from "../src/launch.js";
import { guardRun } from "../src/supervise.js";
import { parsed } from "./fixtures/bindings.js";

let work = "";
beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "hobo-signals-test-"));
});
afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

class Stub extends EventEmitter implements SpawnedProcess {
	readonly stderr = new PassThrough();
	readonly killed: string[] = [];
	kill(signal: NodeJS.Signals): boolean {
		this.killed.push(signal);
		return true;
	}
}

/** Every event the run listens to. */
const EVENTS = ["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT", "exit"] as const;
const NONE = Object.fromEntries(EVENTS.map((name) => [name, 0]));

/** An existing executable file, so the launch's own checks pass; the stub stands in for the process. */
const BIN = process.execPath;

function schemaDirs(): string[] {
	return readdirSync(work).filter((n) => n.startsWith("hobo-opensesame-"));
}

function listeners(host: EventEmitter): Record<string, number> {
	return Object.fromEntries(
		EVENTS.map((name) => [name, host.listenerCount(name)]),
	);
}

function input(overrides: Partial<RunInput> = {}): RunInput {
	return {
		bin: BIN,
		bindings: parsed(),
		argv: ["node", "app.js"],
		env: { PATH: process.env.PATH ?? "" },
		probe: () => ({ status: 0, stdout: "opensesame 0.1.0\n" }),
		stderr: new PassThrough(),
		tmpRoot: work,
		...overrides,
	};
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("the run never started");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A run whose OpenSesame is a stub, returned once the stub has been started. */
async function started(overrides: Partial<RunInput> = {}) {
	const stub = new Stub();
	const host = new EventEmitter();
	let spawned = false;
	const run = runProxied(
		input({
			signals: host,
			spawn: () => {
				spawned = true;
				return stub;
			},
			...overrides,
		}),
	);
	await until(() => spawned);
	return { stub, host, run };
}

async function codeOf(run: Promise<unknown>): Promise<string> {
	try {
		await run;
	} catch (error) {
		if (error instanceof OpenSesameAdapterError) return error.code;
		throw error;
	}
	return "no error";
}

describe("a signal to the process that runs OpenSesame is passed on, and ends the run", () => {
	it("passes SIGTERM and SIGHUP on as they are; OpenSesame revokes the run and stops the child", async () => {
		const { stub, host, run } = await started();
		host.emit("SIGTERM", "SIGTERM");
		host.emit("SIGHUP", "SIGHUP");
		expect(stub.killed).toEqual(["SIGTERM", "SIGHUP"]);
		stub.stderr.write(
			"opensesame: SIGTERM: the run is ended and its surrogates are revoked (1); the child is stopped\n",
		);
		stub.emit("close", 143, null);
		expect(await run).toMatchObject({ kind: "signalled", exitCode: 143 });
	});

	it("passes SIGINT and SIGQUIT on as SIGTERM, which is the one that stops the child", async () => {
		const { stub, host, run } = await started({ raise: () => undefined });
		host.emit("SIGINT", "SIGINT");
		host.emit("SIGQUIT", "SIGQUIT");
		expect(stub.killed).toEqual(["SIGTERM", "SIGTERM"]);
		stub.emit("close", 143, null);
		await run;
	});

	it("hears a signal that arrives before OpenSesame is started: nothing is started, nothing is left", async () => {
		const host = new EventEmitter();
		let spawns = 0;
		const run = runProxied(
			input({
				signals: host,
				spawn: () => {
					spawns += 1;
					return new Stub();
				},
			}),
		);
		// Same tick: before the directory is made.
		host.emit("SIGTERM", "SIGTERM");
		expect(await codeOf(run)).toBe("signalled");
		expect(spawns).toBe(0);
		expect(schemaDirs()).toEqual([]);
		expect(listeners(host)).toEqual(NONE);
	});

	it("hears one that arrives while the schema is being written, the same way", async () => {
		const host = new EventEmitter();
		let spawns = 0;
		const run = runProxied(
			input({
				signals: host,
				spawn: () => {
					spawns += 1;
					return new Stub();
				},
			}),
		);
		await new Promise((resolve) => setImmediate(resolve));
		host.emit("SIGHUP", "SIGHUP");
		expect(await codeOf(run)).toBe("signalled");
		expect(spawns).toBe(0);
		expect(schemaDirs()).toEqual([]);
	});
});

describe("the run's handlers are removed however it ends", () => {
	it("while it runs there is one of each, and when the command ends none", async () => {
		const { stub, host, run } = await started();
		expect(listeners(host)).toEqual({
			SIGTERM: 1,
			SIGHUP: 1,
			SIGINT: 1,
			SIGQUIT: 1,
			exit: 1,
		});
		stub.emit("close", 0, null);
		await run;
		expect(listeners(host)).toEqual(NONE);
	});

	it("when OpenSesame cannot be started", async () => {
		const { stub, host, run } = await started();
		stub.emit("error", Object.assign(new Error("spawn"), { code: "ENOENT" }));
		expect(await codeOf(run)).toBe("opensesame_bin_missing");
		expect(listeners(host)).toEqual(NONE);
		expect(schemaDirs()).toEqual([]);
	});

	it("when the schema cannot be written", async () => {
		const host = new EventEmitter();
		const run = runProxied(
			input({
				signals: host,
				tmpRoot: join(work, "no", "such", "root"),
			}),
		);
		await expect(run).rejects.toThrow(/ENOENT/u);
		expect(listeners(host)).toEqual(NONE);
	});

	it("when the launch is refused, nothing was ever listened to", async () => {
		const host = new EventEmitter();
		const run = runProxied(input({ signals: host, argv: [] }));
		expect(await codeOf(run)).toBe("launch_invalid");
		expect(listeners(host)).toEqual(NONE);
	});
});

describe("a process that exits mid-run takes the run with it", () => {
	it("stops OpenSesame and removes the schema from the exit event, which no signal and no await can reach", async () => {
		const { stub, host, run } = await started();
		expect(schemaDirs()).toHaveLength(1);
		host.emit("exit", 1);
		expect(stub.killed).toEqual(["SIGTERM"]);
		expect(schemaDirs()).toEqual([]);
		stub.emit("close", 143, null);
		await run;
		expect(listeners(host)).toEqual(NONE);
	});

	it("does not signal a command that has already ended", async () => {
		const { stub, host, run } = await started();
		stub.emit("close", 0, null);
		await run;
		host.emit("exit", 0);
		expect(stub.killed).toEqual([]);
	});
});

describe("an interrupt that stopped the run ends the process that was interrupted", () => {
	type Raised = {
		signal: string;
		dirs: string[];
		listeners: Record<string, number>;
	};

	async function endedBy(signal: NodeJS.Signals): Promise<Raised[]> {
		const raised: Raised[] = [];
		const host = new EventEmitter();
		const { stub, run } = await started({
			signals: host,
			raise: (raisedSignal) => {
				raised.push({
					signal: raisedSignal,
					dirs: schemaDirs(),
					listeners: listeners(host),
				});
			},
		});
		host.emit(signal, signal);
		stub.emit("close", 143, null);
		await run;
		return raised;
	}

	it("re-raises SIGINT and SIGQUIT once the schema is gone and the handlers are off, so the default action runs", async () => {
		for (const signal of ["SIGINT", "SIGQUIT"] as const) {
			expect(await endedBy(signal), signal).toEqual([
				{ signal, dirs: [], listeners: NONE },
			]);
		}
	});

	it("leaves SIGTERM and SIGHUP to the caller, who gets the outcome", async () => {
		for (const signal of ["SIGTERM", "SIGHUP"] as const) {
			expect(await endedBy(signal), signal).toEqual([]);
		}
	});

	it("re-raises the interrupt even when the run was never started", async () => {
		const host = new EventEmitter();
		const raised: string[] = [];
		const run = runProxied(
			input({ signals: host, raise: (signal) => raised.push(signal) }),
		);
		host.emit("SIGINT", "SIGINT");
		expect(await codeOf(run)).toBe("signalled");
		expect(raised).toEqual(["SIGINT"]);
	});

	it("raises nothing when nothing interrupted the run", async () => {
		const raised: string[] = [];
		const { stub, run } = await started({
			raise: (signal) => raised.push(signal),
		});
		stub.emit("close", 0, null);
		await run;
		expect(raised).toEqual([]);
	});
});

describe("a signal that finds nothing running is not lost", () => {
	it("re-raises SIGTERM and SIGHUP that arrive after the command ended, once the schema is gone", async () => {
		for (const signal of ["SIGTERM", "SIGHUP"] as const) {
			const raised: { signal: string; dirs: string[] }[] = [];
			const host = new EventEmitter();
			const { stub, run } = await started({
				signals: host,
				remove: (dir) => {
					// The command has ended; the supervisor says stop while the schema is being removed.
					host.emit(signal, signal);
					return rm(dir, { recursive: true, force: true });
				},
				raise: (raisedSignal) => {
					raised.push({ signal: raisedSignal, dirs: schemaDirs() });
				},
			});
			stub.emit("close", 0, null);
			await run;
			expect(stub.killed, signal).toEqual([]);
			expect(raised, signal).toEqual([{ signal, dirs: [] }]);
		}
	});

	it("re-raises SIGTERM that arrived before OpenSesame was started, which the run refused to start for", async () => {
		const host = new EventEmitter();
		const raised: string[] = [];
		const run = runProxied(
			input({ signals: host, raise: (signal) => raised.push(signal) }),
		);
		host.emit("SIGTERM", "SIGTERM");
		expect(await codeOf(run)).toBe("signalled");
		expect(raised).toEqual(["SIGTERM"]);
	});

	it("does not re-raise a SIGTERM that reached a running OpenSesame, but does one that came after it", () => {
		const host = new EventEmitter();
		const raised: string[] = [];
		const killed: string[] = [];
		const guard = guardRun(host, (signal) => raised.push(signal));
		guard.attach({
			stderr: null,
			on: () => undefined,
			kill: (signal) => {
				killed.push(signal);
				return true;
			},
		});
		host.emit("SIGTERM", "SIGTERM");
		guard.detach();
		host.emit("SIGHUP", "SIGHUP");
		guard.release();
		expect(killed).toEqual(["SIGTERM"]);
		expect(raised).toEqual(["SIGHUP"]);
	});
});

describe("the exit handler cannot make the process lose its other exit handlers", () => {
	it("survives a schema directory it cannot remove and a kill that throws, and later listeners still run", () => {
		const host = new EventEmitter();
		const guard = guardRun(host, undefined);
		guard.own("not\0a-path");
		guard.attach({
			stderr: null,
			on: () => undefined,
			kill: () => {
				throw new Error("ESRCH");
			},
		});
		let later = 0;
		host.on("exit", () => {
			later += 1;
		});
		expect(() => host.emit("exit", 1)).not.toThrow();
		expect(later).toBe(1);
		guard.release();
	});

	it("still removes the directory when the kill throws", () => {
		const host = new EventEmitter();
		const dir = mkdtempSync(join(work, "hobo-opensesame-"));
		const guard = guardRun(host, undefined);
		guard.own(dir);
		guard.attach({
			stderr: null,
			on: () => undefined,
			kill: () => {
				throw new Error("EPERM");
			},
		});
		host.emit("exit", 1);
		expect(schemaDirs()).toEqual([]);
		guard.release();
	});
});

describe("the schema directory is found again wherever the process has gone by the end", () => {
	it("a relative temp root is made absolute at the start: a chdir during the run leaves nothing behind", async () => {
		const here = process.cwd();
		mkdirSync(join(work, "t"));
		mkdirSync(join(work, "elsewhere"));
		process.chdir(work);
		try {
			const { stub, run } = await started({ tmpRoot: "t" });
			process.chdir(join(work, "elsewhere"));
			stub.emit("close", 0, null);
			await run;
		} finally {
			process.chdir(here);
		}
		expect(
			readdirSync(join(work, "t")).filter((n) =>
				n.startsWith("hobo-opensesame-"),
			),
		).toEqual([]);
	});

	it("hands OpenSesame an absolute schema path whatever the temp root was", async () => {
		mkdirSync(join(work, "t"));
		const here = process.cwd();
		process.chdir(work);
		try {
			const seen: string[] = [];
			const stub = new Stub();
			const host = new EventEmitter();
			const run = runProxied(
				input({
					signals: host,
					tmpRoot: "t",
					spawn: (_command, args) => {
						seen.push(args[3] ?? "");
						return stub;
					},
				}),
			);
			await until(() => seen.length === 1);
			stub.emit("close", 0, null);
			await run;
			expect(seen[0]).toMatch(/^\//u);
			expect(seen[0]).toContain(join(work, "t"));
		} finally {
			process.chdir(here);
		}
	});
});

describe("a failing removal is not the run's error", () => {
	const failing = () => Promise.reject(new Error("EBUSY: busy"));

	it("returns the outcome of a run that finished, and lets go of the handlers", async () => {
		const host = new EventEmitter();
		const { stub, run } = await started({ signals: host, remove: failing });
		stub.emit("close", 0, null);
		expect(await run).toMatchObject({ kind: "child_exit", exitCode: 0 });
		expect(listeners(host)).toEqual(NONE);
	});

	it("does not mask the error that ended the run", async () => {
		const host = new EventEmitter();
		const { stub, run } = await started({ signals: host, remove: failing });
		stub.emit("error", Object.assign(new Error("spawn"), { code: "ENOENT" }));
		expect(await codeOf(run)).toBe("opensesame_bin_missing");
		expect(listeners(host)).toEqual(NONE);
	});
});

describe("the read of OpenSesame's stderr ends soon after OpenSesame does", () => {
	it("resolves with the outcome and lets go of the pipe when a descendant holds it open after the exit", async () => {
		const { stub, run } = await started({ stderrGraceMs: 20 });
		let destroyed = false;
		Object.assign(stub.stderr, { destroy: () => (destroyed = true) });
		stub.stderr.write("opensesame: surrogate.misdirected: x\n");
		stub.emit("exit", 77, null);
		// No close: something else still holds the write end.
		expect(await run).toMatchObject({ kind: "tripwire", exitCode: 77 });
		expect(destroyed).toBe(true);
	});

	it("does not cut off a close that comes inside the grace, and settles once", async () => {
		const { stub, run } = await started({ stderrGraceMs: 5_000 });
		stub.emit("exit", 3, null);
		stub.emit("close", 3, null);
		expect(await run).toMatchObject({ kind: "child_exit", exitCode: 3 });
	});
});
