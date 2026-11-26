import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER = "scripts/run-script.mts";

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const RECORD = `import { appendFileSync } from "node:fs";
appendFileSync("args.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
`;

/** A package with the launcher and the scripts a test asks for. */
function checkout(scripts: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-run-script-"));
	scratch.push(dir);
	mkdirSync(join(dir, "scripts"));
	copyFileSync(join(root, LAUNCHER), join(dir, LAUNCHER));
	writeFileSync(join(dir, "record.mjs"), RECORD);
	writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
	return dir;
}

function launch(dir: string, args: string[], cwd = dir) {
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", join(dir, LAUNCHER), ...args],
		{ cwd, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
	);
}

function received(dir: string): string[][] {
	const file = join(dir, "args.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line): string[] => JSON.parse(line));
}

// `node --run <script> -- <args>` splices the arguments into the shell
// command and escapes `'` as `\'` inside single quotes, which sh does not
// honour: `--base=main';touch PWNED;#` ran `touch PWNED`. The launcher hands
// them to the script as positional parameters instead.
describe("scripts/run-script.mts", () => {
	it("passes every argument through as itself", () => {
		const dir = checkout({ show: "node record.mjs" });
		const args = [
			"it's",
			"a;b",
			"$HOME",
			"`id`",
			"two words",
			'"quoted"',
			"--base=main';touch${IFS}PWNED;#",
		];
		const result = launch(dir, ["show", "--", ...args]);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(received(dir), [args]);
		assert.equal(existsSync(join(dir, "PWNED")), false);
	});

	it("drops one leading -- and keeps the rest, as pnpm run does", () => {
		const dir = checkout({ show: "node record.mjs" });
		launch(dir, ["show", "--staged"]);
		launch(dir, ["show", "--", "--staged"]);
		launch(dir, ["show", "--", "--", "x"]);
		launch(dir, ["show"]);
		assert.deepEqual(received(dir), [
			["--staged"],
			["--staged"],
			["--", "x"],
			[],
		]);
	});

	it("runs from the package root with node_modules/.bin first on PATH", () => {
		const dir = checkout({ greet: "hello && node record.mjs here" });
		const bin = join(dir, "node_modules", ".bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "hello"), "#!/bin/sh\necho hello-from-bin\n");
		chmodSync(join(bin, "hello"), 0o755);
		mkdirSync(join(dir, "nested"));
		const result = launch(dir, ["greet"], join(dir, "nested"));
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /hello-from-bin/u);
		assert.deepEqual(received(dir), [["here"]]);
	});

	it("exits with the script's status", () => {
		const dir = checkout({ fail: "exit 3" });
		assert.equal(launch(dir, ["fail"]).status, 3);
	});

	it("refuses an unknown script, a pre/post-hooked one, or no name", () => {
		const dir = checkout({
			show: "node record.mjs",
			hooked: "node record.mjs hooked",
			prehooked: "node record.mjs pre",
			after: "node record.mjs after",
			postafter: "node record.mjs post",
		});
		for (const [args, says] of [
			[["no-such-script"], /no script named no-such-script/u],
			[["constructor"], /no script named constructor/u],
			[["hooked"], /pre or post script/u],
			[["after"], /pre or post script/u],
			[[], /usage/u],
			[["--", "show"], /usage/u],
		] as const) {
			const result = launch(dir, [...args]);
			assert.equal(result.status, 2, args.join(" "));
			assert.match(result.stderr, says);
		}
		assert.deepEqual(received(dir), []);
	});
});
