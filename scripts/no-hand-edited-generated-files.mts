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
		/^packages\/ci-vercel\/scripts\/generate-(assets|proxy-bundle)\.mts$/.test(
			file,
		) ||
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

// Catch-up case: output for a schema that landed in an *earlier* commit.
//
// The staged-source check above is a proxy for the property that actually
// matters — "generated output matches its sources" — and the proxy cannot
// express a commit that only emits missing output. Rather than widen it into an
// allowlist, verify the real property: the codegen checker regenerates into a
// scratch tree and reports DRIFT if anything on disk differs from what the
// current schemas produce. CLEAN means these files are exactly what the
// generator emits, which is the whole point of the guard.
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
console.error(
	"Generated outputs changed without matching protobuf/CUE source or generator change:",
);
for (const file of generated) console.error(`- ${file}`);
console.error(
	"Edit schema/generator sources, then run the relevant codegen command.",
);
process.exit(1);
