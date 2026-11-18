import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createDecision,
	createDecisionRequest,
	POLICY_IR_SCHEMA_VERSION,
} from "@hobo/policy";
import { sampleManifestRecord } from "./manifest.js";

function options(args: readonly string[]) {
	let seed = 1742;
	let runs = 100_000;
	let index = args[0] === "--" ? 1 : 0;
	while (index < args.length) {
		const option = args[index];
		const raw = args[index + 1];
		if (
			(option !== "--seed" && option !== "--runs") ||
			!raw ||
			!/^(0|[1-9][0-9]*)$/u.test(raw)
		) {
			throw new Error("usage: jazzer-cli [--seed INTEGER] [--runs INTEGER]");
		}
		const value = Number(raw);
		if (
			!Number.isSafeInteger(value) ||
			value > 1_000_000 ||
			(option === "--runs" && value < 1)
		) {
			throw new Error("invalid Jazzer campaign limit");
		}
		if (option === "--seed") seed = value;
		else runs = value;
		index += 2;
	}
	return { seed, runs };
}

async function run(seed: number, runs: number) {
	const directory = await mkdtemp(join(tmpdir(), "hobo-jazzer-"));
	try {
		const request = createDecisionRequest({
			schemaVersion: POLICY_IR_SCHEMA_VERSION,
			subject: { kind: "agent", id: "agent-a" },
			action: "deploy",
			resource: { kind: "service", id: "api" },
			phase: "apply",
		});
		const decision = createDecision(request, {
			effect: "allow",
			reason: "scoped",
			evidence: { policyIds: [], engine: "fuzz" },
		});
		const seeds = {
			manifest: sampleManifestRecord(),
			event: {
				id: "event-1",
				type: "demo.Created",
				v: 1,
				streamId: "demo:1",
				seq: 1,
				ts: "2026-01-01T00:00:00.000Z",
				actor: { kind: "agent", id: "agent-a" },
				tenant: "tenant-a",
				data: { ok: true },
			},
			policy: { request, decision },
		};
		for (const [name, value] of Object.entries(seeds)) {
			await writeFile(join(directory, `${name}.json`), JSON.stringify(value), {
				mode: 0o600,
			});
		}
		const cli = createRequire(import.meta.url).resolve(
			"@jazzer.js/core/dist/cli.js",
		);
		const target = fileURLToPath(
			new URL("../dist/jazzer-entry.js", import.meta.url),
		);
		const result = await new Promise<{ status: number | null; output: string }>(
			(resolve, reject) => {
				const child = spawn(
					process.execPath,
					[
						cli,
						target,
						directory,
						"--sync",
						"--",
						`-seed=${seed}`,
						`-runs=${runs}`,
						"-max_len=65536",
						"-timeout=5",
						"-max_total_time=300",
					],
					{
						cwd: directory,
						env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let output = "";
				const capture = (chunk: Buffer) => {
					output = (output + chunk.toString()).slice(-65_536);
				};
				child.stdout.on("data", capture);
				child.stderr.on("data", capture);
				const interrupt = () => child.kill("SIGTERM");
				process.once("SIGINT", interrupt);
				process.once("SIGTERM", interrupt);
				const timer = setTimeout(() => child.kill("SIGKILL"), 330_000);
				const clear = () => {
					clearTimeout(timer);
					process.removeListener("SIGINT", interrupt);
					process.removeListener("SIGTERM", interrupt);
				};
				child.once("error", (error) => {
					clear();
					reject(error);
				});
				child.once("close", (status) => {
					clear();
					resolve({ status, output });
				});
			},
		);
		const done = result.output.match(/#(\d+)\s+DONE\s+cov:\s+(\d+)/u);
		const executed = Number(done?.[1]);
		const coverage = Number(done?.[2]);
		if (result.status !== 0 || !done || executed < runs || coverage < 1) {
			throw new Error(`Jazzer failed: ${result.output.slice(-4000)}`);
		}
		return { seed, runs: executed, coverage };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

try {
	const { seed, runs } = options(process.argv.slice(2));
	process.stdout.write(`${JSON.stringify(await run(seed, runs))}\n`);
} catch (error) {
	process.stderr.write(
		`Jazzer campaign failed: ${error instanceof Error ? error.message : "unexpected error"}\n`,
	);
	process.exitCode = 1;
}
