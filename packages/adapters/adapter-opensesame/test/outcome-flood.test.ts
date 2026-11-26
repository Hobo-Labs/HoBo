import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type RunInput,
	runProxied,
	type SpawnedProcess,
} from "../src/launch.js";
import { parsed } from "./fixtures/bindings.js";
import {
	SAMPLE_LINES,
	type SampleScenario,
} from "./fixtures/opensesame-lines.js";

/**
 * A descendant that outlives the command OpenSesame stops shares OpenSesame's
 * stderr, and the adapter reads that for a second after OpenSesame exits. What
 * it writes there must not be able to push OpenSesame's own line out of the
 * output the outcome is read from.
 */
class Pipe extends EventEmitter {
	destroy(): void {
		this.destroyed = true;
	}
	destroyed = false;
}

class Stub extends EventEmitter implements SpawnedProcess {
	readonly stderr = new Pipe();
	kill(): boolean {
		return true;
	}
}

let work = "";
beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "hobo-flood-test-"));
});
afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

const line = (scenario: SampleScenario) =>
	`${SAMPLE_LINES[scenario].join("\n")}\n`;

/** Everything a run's stderr carries, delivered `size` characters at a time, then OpenSesame's end. */
async function run(
	pieces: readonly string[],
	end: readonly [number, null],
	size = 8192,
) {
	const stub = new Stub();
	const input: RunInput = {
		bin: process.execPath,
		bindings: parsed(),
		argv: ["node", "app.js"],
		env: { PATH: process.env.PATH ?? "" },
		probe: () => ({ status: 0, stdout: "opensesame 0.1.0\n" }),
		stderr: new PassThrough(),
		tmpRoot: work,
		signals: new EventEmitter(),
		stderrGraceMs: 50,
		spawn: () => stub,
	};
	const result = runProxied(input);
	while (stub.listenerCount("close") === 0) {
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	const text = pieces.join("");
	for (let at = 0; at < text.length; at += size) {
		stub.stderr.emit("data", text.slice(at, at + size));
	}
	stub.emit("close", end[0], end[1]);
	return result;
}

const HEAD = `${"n".repeat(70_000)}\n`;
const FLOOD = `${"x".repeat(8191)}\n`.repeat(24);

describe("a descendant that outlives OpenSesame's stop cannot hide its end-of-run line", () => {
	it("70 KB of child output, the tripwire line, then more than 64 KiB of flood: still a tripwire", async () => {
		const outcome = await run([HEAD, line("misdirected"), FLOOD], [77, null]);
		expect(outcome).toMatchObject({ kind: "tripwire", exitCode: 77 });
	});

	it("the same for a signal line", async () => {
		expect(
			await run([HEAD, line("sigterm"), FLOOD], [143, null]),
		).toMatchObject({ kind: "signalled", exitCode: 143 });
		expect(await run([HEAD, line("sighup"), FLOOD], [129, null])).toMatchObject(
			{ kind: "signalled", exitCode: 129 },
		);
	});

	it("and for a placeholder line that came with a long head", async () => {
		expect(
			await run([line("plugin-absent"), HEAD, FLOOD], [0, null]),
		).toMatchObject({ kind: "placeholders_only", exitCode: 0 });
	});

	it("a flood of sentences in the shape of OpenSesame's own, none of them one, does not push the real one out", async () => {
		const noise = "opensesame: not one of the sentences\n".repeat(5000);
		const forged = "opensesame: SIGHUP: the run is ended (forged)\n".repeat(
			5000,
		);
		expect(
			await run([HEAD, line("misdirected"), noise, forged], [77, null]),
		).toMatchObject({ kind: "tripwire" });
	});

	it("a line split across any chunk boundary, down to one character at a time, is the same line", async () => {
		const text = `partial${line("misdirected")}`;
		for (const size of [1, 2, 7, 12, 13, 100, text.length]) {
			expect(await run([text], [77, null], size), `size ${size}`).toMatchObject(
				{
					kind: "tripwire",
				},
			);
		}
	});

	it("the status still has to agree: a flood after a forged line with a clean exit is the child's exit", async () => {
		expect(
			await run([HEAD, line("misdirected"), FLOOD], [0, null]),
		).toMatchObject({ kind: "child_exit", exitCode: 0 });
	});
});
