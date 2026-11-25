// The command the HoBo CI Fabric workflow runs after a green main build:
// `node --import tsx packages/ci/src/freight-cli.ts --out <dir> ...
//   --deliverable <id>=<file>`.
// It writes every CI output of the build (src/freight.ts) under <dir> at its
// output path, plus `ci-result.json`, the passing `ci.PipelineResultObserved`
// shape a HOBO_CI source reads. A deliverable this run did not build is named
// on stdout, never invented. Nothing is recorded in CD from here: the outputs
// are what a HOBO_CI source re-reads and verifies (I15).
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
	type CiBuild,
	CiFreightError,
	ciFreightOutputs,
	ciFreightResult,
	HOBO_DELIVERABLES,
} from "./freight.js";

export type CiFreightCliIo = Readonly<{
	write?: (text: string) => void;
	/** `$GITHUB_OUTPUT`, when the CI reads step outputs from a file. */
	githubOutput?: string;
}>;

const USAGE =
	"usage: freight-cli --out <dir> --repository <owner/name> --commit <sha> --ref <ref> --pipeline <id> --run-id <id> --ci-system <name> --builder-id <uri> --deliverable <id>=<file> [...]";

function parseCliArgs(args: readonly string[]) {
	return parseArgs({
		args: [...args],
		options: {
			out: { type: "string" },
			repository: { type: "string" },
			commit: { type: "string" },
			ref: { type: "string" },
			pipeline: { type: "string" },
			"run-id": { type: "string" },
			"ci-system": { type: "string" },
			"builder-id": { type: "string" },
			deliverable: { type: "string", multiple: true },
		},
		strict: true,
	});
}

export async function runCiFreightCli(
	args: readonly string[],
	io: CiFreightCliIo = {},
): Promise<number> {
	const write = io.write ?? ((text: string) => process.stdout.write(text));
	let parsed: ReturnType<typeof parseCliArgs>;
	try {
		parsed = parseCliArgs(args);
	} catch (error) {
		write(
			`${error instanceof Error ? error.message : "bad arguments"}\n${USAGE}\n`,
		);
		return 2;
	}
	const { values } = parsed;
	const given = {
		out: values.out ?? "",
		repository: values.repository ?? "",
		commit: values.commit ?? "",
		ref: values.ref ?? "",
		pipeline: values.pipeline ?? "",
		"run-id": values["run-id"] ?? "",
		"ci-system": values["ci-system"] ?? "",
		"builder-id": values["builder-id"] ?? "",
	};
	const missing = Object.entries(given)
		.filter(([, value]) => value === "")
		.map(([name]) => name);
	if (missing.length > 0) {
		write(`missing --${missing.join(", --")}\n${USAGE}\n`);
		return 2;
	}
	const build: CiBuild = {
		repository: given.repository,
		commit: given.commit,
		ref: given.ref,
		pipeline: given.pipeline,
		runId: given["run-id"],
		ciSystem: given["ci-system"],
		builderId: given["builder-id"],
	};
	const requested = values.deliverable ?? [];
	const built: { id: string; bytes: Uint8Array }[] = [];
	for (const entry of requested) {
		const at = entry.indexOf("=");
		const id = at > 0 ? entry.slice(0, at) : "";
		const file = at > 0 ? entry.slice(at + 1) : "";
		if (!Object.values(HOBO_DELIVERABLES).some((item) => item.id === id)) {
			write(
				`unknown HoBo deliverable ${id || entry}; known: ${Object.keys(HOBO_DELIVERABLES).join(", ")}\n`,
			);
			return 2;
		}
		built.push({ id, bytes: new Uint8Array(await readFile(file)) });
	}
	if (built.length === 0) {
		write(`no deliverable was given; nothing to emit\n${USAGE}\n`);
		return 2;
	}
	let emitted: ReturnType<typeof ciFreightOutputs>;
	try {
		emitted = ciFreightOutputs(build, built);
	} catch (error) {
		if (!(error instanceof CiFreightError)) throw error;
		for (const reason of error.reasons)
			write(`refused ${reason.subject}: ${reason.code}: ${reason.message}\n`);
		return 1;
	}
	const out = resolve(given.out);
	for (const output of emitted.outputs) {
		const path = join(out, ...output.path.split("/"));
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, output.bytes);
		write(`output ${output.path} sha256:${output.sha256}\n`);
	}
	const resultPath = join(out, "ci-result.json");
	await writeFile(
		resultPath,
		`${JSON.stringify(ciFreightResult(build, emitted.outputs), null, 2)}\n`,
	);
	for (const deliverable of Object.values(HOBO_DELIVERABLES))
		if (!built.some((item) => item.id === deliverable.id))
			write(`skipped ${deliverable.id}: not built by this run\n`);
	const bindles = emitted.manifests.map((manifest) => manifest.bindle);
	if (io.githubOutput)
		appendFileSync(
			io.githubOutput,
			`ci-result=${resultPath}\nfreight-bindles=${JSON.stringify(bindles)}\n`,
		);
	return 0;
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	const githubOutput = process.env.GITHUB_OUTPUT;
	process.exitCode = await runCiFreightCli(
		process.argv.slice(2),
		githubOutput ? { githubOutput } : {},
	);
}
