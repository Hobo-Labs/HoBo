import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { toJsonString } from "@bufbuild/protobuf";
import { LocalRunReceiptSchema } from "../src/_generated/readiness_pb.js";
import { localParams } from "../src/local-config.js";
import {
	CI_CF_ROOT,
	prepareLocal,
	readPreparation,
} from "../src/local-preparation.js";
import {
	checkedProcess,
	freeLocalPort,
	localRuntimeEnvironment,
	runLocal,
} from "../src/local-runtime.js";

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			source: { type: "string" },
			pipeline: { type: "string" },
			ref: { type: "string", default: "HEAD" },
			directory: { type: "string" },
			"work-root": { type: "string" },
			port: { type: "string" },
			dockerfile: { type: "string" },
			resume: { type: "string" },
			json: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		console.log(
			"HoBo Cloudflare CI: prepare|dev|trigger|run\nprepare/run: --source GIT_REPO --pipeline JSON [--ref HEAD] [--dockerfile PATH]\nrun/dev/trigger: --directory PREPARATION [--resume WORKFLOW_ID (run)]\n--work-root PATH --port PORT --json",
		);
		return;
	}
	const [action] = positionals;
	if (
		positionals.length !== 1 ||
		!["prepare", "dev", "trigger", "run"].includes(action ?? "")
	)
		throw new Error("use prepare, dev, trigger or run; --help lists options");
	if (values.resume && action !== "run")
		throw new Error("--resume is only valid for run");
	if (
		values.directory &&
		(values.source || values.pipeline || values.dockerfile)
	)
		throw new Error(
			"use --directory for immutable prepared inputs, or --source/--pipeline to prepare new inputs",
		);
	const work = values["work-root"]
		? resolve(values["work-root"])
		: join(CI_CF_ROOT, ".hobo", "work");
	const cancellation = new AbortController();
	const cancel = () =>
		cancellation.abort(new Error("local CI cancelled by signal"));
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		let directory: string;
		if (
			action === "prepare" ||
			(action === "run" && !values.directory && !values.resume)
		) {
			if (!values.source || !values.pipeline)
				throw new Error(
					"prepare/run requires --source GIT_REPO and --pipeline JSON, or run --directory PREPARATION",
				);
			const port = values.port
				? Number(values.port)
				: action === "run"
					? await freeLocalPort()
					: 8787;
			if (!Number.isInteger(port) || port < 1 || port > 65535)
				throw new Error("port must be 1..65535");
			directory = await prepareLocal(
				resolve(values.source),
				resolve(values.pipeline),
				values.ref,
				work,
				port,
				values.dockerfile ? resolve(values.dockerfile) : undefined,
			);
		} else
			directory = values.directory
				? resolve(values.directory)
				: (await readFile(join(work, "latest"), "utf8")).trim();
		const preparation = await readPreparation(directory);
		if (action === "prepare") {
			console.log(
				`Prepared Git commit ${preparation.sourceSha} in ${directory}`,
			);
			console.log(
				"Committed source and pinned initialized submodules are included; uncommitted files are excluded.",
			);
			console.log(
				`Run: pnpm --filter @hobo/ci-cf local:run --directory ${directory}`,
			);
			return;
		}
		if (action === "run") {
			if (!values.json) console.log(`Native run preparation: ${directory}`);
			const receipt = await runLocal(
				directory,
				values.resume,
				cancellation.signal,
			);
			if (values.json)
				console.log(toJsonString(LocalRunReceiptSchema, receipt));
			else
				console.log(
					`${receipt.state?.outcome}: workflow ${receipt.workflowId}\nReceipt: ${join(directory, `run-${receipt.workflowId}.json`)}${receipt.error ? `\n${receipt.error}` : ""}`,
				);
			process.exitCode = receipt.state?.exitCode ?? 2;
			return;
		}
		const env = await localRuntimeEnvironment(directory);
		if (action === "trigger") {
			const id = crypto.randomUUID();
			await checkedProcess(
				process.execPath,
				[
					fileURLToPath(
						new URL("../bin/wrangler.js", import.meta.resolve("wrangler")),
					),
					"workflows",
					"trigger",
					"hobo-ci-cf-local",
					"--local",
					"--port",
					String(preparation.port),
					"--id",
					id,
					"--params",
					JSON.stringify(localParams(preparation.sourceSha, preparation.id)),
					"--config",
					join(directory, "wrangler.jsonc"),
				],
				join(directory, "trigger.log"),
				env,
				15000,
			);
			console.log(
				`Submitted workflow ${id}; inspect its terminal status. Submission is not a passing check.`,
			);
		} else {
			const child = spawn(
				process.execPath,
				["--import", "tsx", join(CI_CF_ROOT, "src/local-server.ts"), directory],
				{ env, stdio: "inherit" },
			);
			cancellation.signal.addEventListener(
				"abort",
				() => child.kill("SIGTERM"),
				{ once: true },
			);
			await new Promise<void>((resolvePromise, reject) => {
				child.once("error", reject);
				child.once("exit", (code) => {
					process.exitCode = cancellation.signal.aborted ? 130 : (code ?? 1);
					resolvePromise();
				});
			});
		}
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}

main().catch((error: Error) => {
	console.error(`HoBo Cloudflare CI: ${error.message}`);
	process.exitCode = 2;
});
