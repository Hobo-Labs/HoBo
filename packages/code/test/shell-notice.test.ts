import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { runInteractiveShell } from "../src/interactive-shell.js";

// A forward the shell runs behind its screen can end while the shell stays:
// ssh refused, or the authorization's lease ran out. The host tells the
// shell (onNotice), and the shell shows it in the transcript, as it shows a
// verb's answer.

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) {
		rmSync(home, { recursive: true, force: true });
	}
});

const NOTICE = "✕ forward · box\n ssh exited with 255\n ─────────────";

describe("the shell, told by its host that a forward ended", () => {
	it("shows the notice in its transcript", async () => {
		const home = mkdtempSync(join(tmpdir(), "hobo-shell-notice-"));
		homes.push(home);
		let output = "";
		const stdout = new Writable({
			write: (chunk, _encoding, done) => {
				output = `${output}${String(chunk)}`;
				done();
			},
		});
		const code = await runInteractiveShell({
			stdin: new PassThrough(),
			stdout,
			hoboHome: home,
			sidecars: false,
			reducedMotion: true,
			// The shell runs this long, and the notice comes while it does.
			maxMs: 1_500,
			host: {
				runVerb: async () => "",
				complete: async () => "",
				onNotice: (listener) => {
					const later = setTimeout(() => listener(NOTICE), 100);
					return () => clearTimeout(later);
				},
			},
		});
		expect(code).toBe(0);
		expect(output).toContain("✕ forward · box");
		expect(output).toContain("ssh exited with 255");
	}, 30_000);
});
