import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { executePipeline, parsePipeline } from "@hobo/ci";
import { createDaggerBackend } from "../dist/backend.js";

const { values } = parseArgs({
	options: {
		image: {
			type: "string",
			default:
				"mirror.gcr.io/library/debian@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3",
		},
	},
});
if (!process.env.DAGGER_SESSION_PORT || !process.env.DAGGER_SESSION_TOKEN)
	throw new Error(
		"Run this lane inside an explicitly selected local Dagger API session",
	);
const workspace = await mkdtemp(join(tmpdir(), "hobo-dagger-sdk-acceptance-"));
try {
	const backend = createDaggerBackend({
		sourceDirectory: workspace,
		image: values.image,
	});
	const result = await executePipeline(
		backend,
		parsePipeline(
			JSON.stringify({
				id: randomUUID(),
				accountId: "local-acceptance",
				timeoutSeconds: 60,
				steps: [
					{
						id: "write",
						cwd: ".",
						argv: [
							"sh",
							"-ec",
							"printf '\\000\\001\\377' > artifact.bin; printf '%s\\n' \"$FIRST\"",
						],
						env: { FIRST: "first" },
					},
					{
						id: "read",
						cwd: ".",
						argv: ["sh", "-ec", 'test -z "${FIRST+x}"; wc -c < artifact.bin'],
						env: {},
					},
				],
				artifactPaths: ["artifact.bin"],
			}),
		),
	);
	assert.equal(result.status, "succeeded", result.error);
	assert.deepEqual(
		result.steps.map((step) => step.stdout),
		["first\n", "3\n"],
	);
	assert.deepEqual(result.artifacts[0]?.data, Uint8Array.from([0, 1, 255]));
	assert.match(result.artifacts[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
	console.log(
		"PASS: SDK commands, workspace snapshots, environment isolation and binary artifact integrity",
	);
	const failed = await executePipeline(
		backend,
		parsePipeline(
			JSON.stringify({
				id: randomUUID(),
				accountId: "local-acceptance",
				timeoutSeconds: 30,
				steps: [
					{
						id: "fail",
						cwd: ".",
						argv: [
							"sh",
							"-c",
							"printf 'partial\\n'; printf 'failure\\n' >&2; exit 23",
						],
						env: {},
					},
					{ id: "never", cwd: ".", argv: ["false"], env: {} },
				],
				artifactPaths: [],
			}),
		),
	);
	assert.equal(failed.status, "failed");
	assert.equal(failed.steps.length, 1);
	assert.equal(failed.steps[0]?.exitCode, 23);
	assert.equal(failed.steps[0]?.stdout, "partial\n");
	assert.equal(failed.steps[0]?.stderr, "failure\n");
	console.log(
		"PASS: SDK nonzero exit code and logs; later steps do not execute",
	);
	const escaped = await executePipeline(
		backend,
		parsePipeline(
			JSON.stringify({
				id: randomUUID(),
				accountId: "local-acceptance",
				timeoutSeconds: 30,
				steps: [
					{
						id: "link",
						cwd: ".",
						argv: ["ln", "-s", "/etc/passwd", "outside-link"],
						env: {},
					},
				],
				artifactPaths: ["outside-link"],
			}),
		),
	);
	assert.equal(escaped.status, "failed");
	assert.equal(escaped.artifacts.length, 0);
	console.log("PASS: SDK artifact symlink containment on a real engine");
} finally {
	await rm(workspace, { recursive: true, force: true });
}
