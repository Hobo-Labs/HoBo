import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runProxied } from "../src/launch.js";
import { parsed } from "./fixtures/bindings.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures/fake-opensesame.mts");
const CHILD = join(here, "fixtures/child.mts");
const PASSPHRASE = "DUMMY_PASSPHRASE_marker";
const NODE_DIR = dirname(process.execPath);

let work = "";
let checkout = "";
let cwd = "";
beforeEach(() => {
	cwd = process.cwd();
	work = mkdtempSync(join(tmpdir(), "hobo-planted-node-"));
	checkout = join(work, "checkout");
	mkdirSync(checkout, { mode: 0o755 });
	// A hostile checkout: a program called `node`, which records what it was started with and then runs the real one.
	writeFileSync(
		join(checkout, "node"),
		`#!/bin/sh\necho "PLANTED node got OPENSESAME_STORE_PASSWORD=$OPENSESAME_STORE_PASSWORD" >> '${work}/stolen.txt'\nexec '${process.execPath}' "$@"\n`,
		{ mode: 0o755 },
	);
	chmodSync(join(checkout, "node"), 0o755);
	symlinkSync(checkout, join(work, "alias"));
	process.chdir(checkout);
});
afterEach(() => {
	process.chdir(cwd);
	rmSync(work, { recursive: true, force: true });
});

describe("OpenSesame's own bare `node` lookup cannot find a planted node with the store passphrase beside it", () => {
	// OpenSesame's first act is to run `node` by name, with everything it was started with but the passphrase's removal for the final child.
	const variants: [string, () => string][] = [
		["a `.` entry first", () => `.${delimiter}${NODE_DIR}`],
		["a trailing empty entry", () => `${NODE_DIR}${delimiter}`],
		[
			"an empty entry in the middle",
			() => `${NODE_DIR}${delimiter}${delimiter}/usr/bin`,
		],
		["a relative entry", () => `../checkout${delimiter}${NODE_DIR}`],
		[
			"a symlink entry to the checkout",
			() => `${join(work, "alias")}${delimiter}${NODE_DIR}`,
		],
		[
			"the checkout by its absolute path",
			() => `${checkout}${delimiter}${NODE_DIR}`,
		],
		[
			"a node_modules/.bin entry",
			() => `${join(checkout, "node_modules", ".bin")}${delimiter}${NODE_DIR}`,
		],
		[
			"a sticky directory anyone can add a file to, like /tmp",
			() => {
				// Sticky stops others removing a name, not adding one: a lookup by name finds what they add.
				const shared = join(work, "shared");
				mkdirSync(shared);
				chmodSync(shared, 0o1777);
				writeFileSync(
					join(shared, "node"),
					readFileSync(join(checkout, "node")),
					{
						mode: 0o755,
					},
				);
				return `${shared}${delimiter}${NODE_DIR}`;
			},
		],
	];
	for (const [label, path] of variants) {
		it(`with ${label}`, async () => {
			mkdirSync(join(checkout, "node_modules", ".bin"), { recursive: true });
			writeFileSync(
				join(checkout, "node_modules", ".bin", "node"),
				readFileSync(join(checkout, "node")),
				{ mode: 0o755 },
			);
			const outcome = await runProxied({
				bin: FAKE,
				bindings: parsed(),
				argv: [
					process.execPath,
					"--no-warnings",
					CHILD,
					join(work, "child.json"),
				],
				env: {
					PATH: path(),
					NODE_NO_WARNINGS: "1",
					OPENSESAME_STORE_PASSWORD: PASSPHRASE,
				},
				passEnv: ["OPENSESAME_STORE_PASSWORD"],
				tmpRoot: work,
				stderr: new PassThrough(),
			});
			expect(outcome).toMatchObject({ kind: "child_exit", exitCode: 0 });
			expect(existsSync(join(work, "stolen.txt"))).toBe(false);
		});
	}
});
