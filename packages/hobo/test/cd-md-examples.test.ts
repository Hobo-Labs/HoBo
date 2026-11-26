// Every `hobo …` example in packages/hobo/CD.md runs against the BUILT binary
// (dist/bin/hobo.js) with --simulate and a temporary HOBO_HOME, from the repo
// root (no Bindle there). None may fail in the shell: no `Unknown option`, no
// usage error, no "No Bindle here". A command's own typed refusal (a missing
// Freight, a placeholder file) is fine: the point is that the binary accepts
// what the document tells people to type.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEPLOY_SUBCOMMANDS } from "@hobo/cli";
import { describe, expect, it } from "vitest";

const PACKAGE = join(import.meta.dirname, "..");
const REPO = join(PACKAGE, "..", "..");
const BIN = join(PACKAGE, "dist", "bin", "hobo.js");
const CD_MD = readFileSync(join(PACKAGE, "CD.md"), "utf8");

/** `hobo …` lines of ```sh fences and `hobo …` inline code spans. */
function examples(markdown: string): string[] {
	const out: string[] = [];
	for (const fence of markdown.matchAll(/```sh\n([\s\S]*?)```/g))
		for (const line of (fence[1] ?? "").split("\n"))
			if (line.trim().startsWith("hobo ")) out.push(line.trim());
	const prose = markdown.replace(/```[\s\S]*?```/g, "");
	for (const span of prose.matchAll(/`(hobo [^`]+)`/g))
		out.push((span[1] ?? "").trim());
	return [...new Set(out)];
}

function argvOf(example: string): string[] {
	return example
		.split(/\s+/)
		.slice(1)
		.map((token) => token.replace(/^"|"$/g, ""));
}

type Ran = Readonly<{ code: number | null; output: string }>;

function runBinary(argv: readonly string[], home: string): Promise<Ran> {
	const serve = argv[0] === "serve";
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [BIN, ...argv], {
			cwd: REPO,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				HOBO_HOME: home,
				NODE_NO_WARNINGS: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const collect = (chunk: Buffer) => {
			output += chunk.toString();
			// `serve cd` runs until stopped: once it has bound, it was accepted.
			if (serve && output.includes("hobo serve cd:")) child.kill("SIGTERM");
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

const EXAMPLES = examples(CD_MD);

describe("CD.md examples", () => {
	it("are concrete commands (no <placeholder>, [optional] or a|b)", () => {
		expect(EXAMPLES.length).toBeGreaterThan(0);
		for (const example of EXAMPLES)
			expect(example, example).not.toMatch(/[<>[\]|]/);
	});

	it("cover every hobo deploy subcommand", () => {
		for (const sub of DEPLOY_SUBCOMMANDS.subcommands.keys())
			expect(
				EXAMPLES.some(
					(e) =>
						e === `hobo deploy ${sub}` || e.startsWith(`hobo deploy ${sub} `),
				),
				sub,
			).toBe(true);
	});

	it.skipIf(!existsSync(BIN))(
		"run from the built binary without a shell refusal",
		{ timeout: 600_000 },
		async () => {
			const failures: string[] = [];
			const queue = [...EXAMPLES];
			const worker = async () => {
				for (let example = queue.shift(); example; example = queue.shift()) {
					const home = await mkdtemp(join(tmpdir(), "cd-md-"));
					try {
						const argv = argvOf(example);
						// --port 0: parallel `serve cd` runs never collide on a port.
						const port = argv.indexOf("--port");
						if (port >= 0) argv[port + 1] = "0";
						const ran = await runBinary(
							[...argv, "--simulate", "--json"],
							home,
						);
						if (
							/Unknown option|HOBO_CLI_USAGE|HOBO_NO_BINDLE|No Bindle here/.test(
								ran.output,
							)
						)
							failures.push(`${example}\n${ran.output.slice(0, 400)}`);
					} finally {
						await rm(home, { recursive: true, force: true });
					}
				}
			};
			await Promise.all(Array.from({ length: 6 }, worker));
			expect(failures).toEqual([]);
		},
	);
});
