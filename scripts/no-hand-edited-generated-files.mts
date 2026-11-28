import { spawnSync } from "node:child_process";

import { GIT_OUTPUT_MAX_BUFFER } from "./lib/git-output.ts";

const staged = spawnSync(
	"git",
	["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
	{ encoding: "utf8", maxBuffer: GIT_OUTPUT_MAX_BUFFER },
);
if (staged.status !== 0) process.exit(staged.status ?? 1);
const files = staged.stdout.split(/\r?\n/).filter(Boolean);
const generated = files.filter((file) =>
	/(^|\/)(generated|_generated(?:-assets)?|src\/gen)(\/|$)/.test(file),
);
if (generated.length === 0) process.exit(0);
const schema = files.some((file) => /\.(proto|cue|wit)$/.test(file));
const generator = files.some(
	(file) =>
		/(^|\/)buf(\.gen)?\.yaml$/.test(file) ||
		/^packages\/ci-vercel\/scripts\/generate-(assets|proxy-bundle|offers)\.mts$/.test(
			file,
		) ||
		/^packages\/ci-vercel\/offers\/[^/]+\.provider\.yaml$/.test(file) ||
		/^src\/draft\/technical-proofs\/s0-04-protobuf-cue-codegen\/packages\/schema-tools\/(src\/(?!_generated\/)|package\.json)/.test(
			file,
		) ||
		/^packages\/schema-tools\/(src\/(?!_generated\/)|package\.json)/.test(
			file,
		) ||
		/^packages\/wit\/(src\/(?!generated\/)|scripts\/|wit-lock\.json)/.test(
			file,
		),
);
if (schema || generator) process.exit(0);

const relayAsset = "packages/ci-vercel/src/_generated-assets/relay-assets.ts";
const relayInput = files.some(
	(file) =>
		file === "packages/ci-gh-actions/templates/hobo-ci-host.yml" ||
		file === "packages/ci-gh-actions/src/bootstrap.ts",
);
if (relayInput && generated.every((file) => file === relayAsset))
	process.exit(0);

const protobufOutputs = generated.every((file) =>
	/^packages\/[^/]+\/src\/_generated\//.test(file),
);
if (protobufOutputs) {
	const check = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"packages/schema-tools/src/cli.ts",
			"--check",
			"--json",
		],
		{ encoding: "utf8" },
	);
	let status = "";
	try {
		// SAFETY: assertion to `.parse(check.stdout) as { status?: string }).st` is required at this boundary.
		status = (JSON.parse(check.stdout) as { status?: string }).status ?? "";
	} catch {
		status = "";
	}
	if (status === "CLEAN") {
		console.error(
			"Generated protobuf outputs staged without a source change; codegen reports CLEAN, so they match their schemas. Allowing.",
		);
		process.exit(0);
	}
	console.error(
		`Generated protobuf outputs staged without a source change, and codegen reports ${status || "an unreadable result"}.`,
	);
}
const proxyBundle =
	"packages/ci-vercel/src/_generated-assets/sandbox-proxy-bundle.ts";
if (generated.every((file) => file === proxyBundle)) {
	const check = spawnSync(
		process.execPath,
		["--import", "tsx", "scripts/generate-proxy-bundle.mts", "--check"],
		{ cwd: "packages/ci-vercel", encoding: "utf8" },
	);
	if (check.status === 0) {
		console.error(
			"Sandbox proxy bundle staged without a generator change; the generator reports it matches its sources. Allowing.",
		);
		process.exit(0);
	}
	console.error(
		"Sandbox proxy bundle staged without a generator change, and the generator reports drift.",
	);
}
console.error(
	"Generated outputs changed without matching protobuf/CUE source or generator change:",
);
for (const file of generated) console.error(`- ${file}`);
console.error(
	"Edit schema/generator sources, then run the relevant codegen command.",
);
process.exit(1);
