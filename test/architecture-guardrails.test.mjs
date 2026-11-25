import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
	checkArchitectureGuardrails,
	implementationPackageRoots,
} from "../scripts/check-architecture-guardrails.mjs";

async function write(root, file, content = "") {
	await mkdir(path.dirname(path.join(root, file)), { recursive: true });
	await writeFile(path.join(root, file), content);
}

async function withFixture(callback) {
	const root = await mkdtemp(
		path.join(tmpdir(), "hobo-architecture-guardrails-"),
	);

	try {
		return await callback(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("architecture guard rejects implementation packages without contract and state proofs", async () => {
	await withFixture(async (root) => {
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/src/demo.mjs",
			"export const ok = true;\n",
		);

		const result = await checkArchitectureGuardrails({
			root,
			files: ["src/draft/technical-proofs/demo-contract/src/demo.mjs"],
		});

		assert.deepEqual(
			result.problems.map((problem) => problem.code),
			[
				"missing-pact-contract",
				"missing-protobuf-definition",
				"missing-cue-constraints",
				"missing-parse-derived-type",
				"missing-event-architecture",
			],
		);
	});
});

test("architecture guard accepts packages with PACT, protobuf, CUE, parsed types, and event architecture evidence", async () => {
	await withFixture(async (root) => {
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/src/demo.mjs",
			"export const ok = true;\n",
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/contracts/pacts/demo-boundary.pact.json",
			JSON.stringify({
				consumer: { name: "demo-consumer" },
				provider: { name: "demo-provider" },
				interactions: [],
			}),
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/proto/demo.proto",
			'syntax = "proto3";\nmessage Demo {}\n',
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/proto/demo.cue",
			"Demo: {}\n",
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/architecture.md",
			[
				"# Demo Architecture",
				"",
				"Parse, don't validate: constructors return derived parsed types after protobuf and CUE constraints pass.",
				"The CQRS actor consumes commands, emits events, and appends to the event store.",
				"A materialized view exposes rx-style projection streams with cached snapshots.",
				"Historical snapshots persist in the read store.",
			].join("\n"),
		);

		const result = await checkArchitectureGuardrails({
			root,
			files: ["src/draft/technical-proofs/demo-contract/src/demo.mjs"],
		});

		assert.deepEqual(result.problems, []);
	});
});

test("architecture guard requires CUE constraints for every protobuf type", async () => {
	await withFixture(async (root) => {
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/src/demo.mjs",
			"export const ok = true;\n",
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/contracts/pacts/demo-boundary.pact.json",
			JSON.stringify({
				consumer: { name: "demo-consumer" },
				provider: { name: "demo-provider" },
				interactions: [],
			}),
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/proto/demo.proto",
			'syntax = "proto3";\nmessage Demo {}\nenum DemoState { DEMO_STATE_UNSPECIFIED = 0; }\n',
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/proto/demo.cue",
			"Demo: {}\n",
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/architecture.md",
			[
				"# Demo Architecture",
				"",
				"Parse, don't validate: constructors return derived parsed types after protobuf and CUE constraints pass.",
				"The CQRS actor consumes commands, emits events, and appends to the event store.",
				"A materialized view exposes rx-style projection streams with cached snapshots.",
				"Historical snapshots persist in the read store.",
			].join("\n"),
		);

		const result = await checkArchitectureGuardrails({
			root,
			files: ["src/draft/technical-proofs/demo-contract/src/demo.mjs"],
		});

		assert.deepEqual(
			result.problems.map((problem) => problem.code),
			["missing-cue-constraints"],
		);
	});
});

test("architecture guard ignores docs-only draft package edits", async () => {
	await withFixture(async (root) => {
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/README.md",
			"# Demo\n",
		);

		const result = await checkArchitectureGuardrails({
			root,
			files: ["src/draft/technical-proofs/demo-contract/README.md"],
		});

		assert.deepEqual(result.problems, []);
	});
});

const architectureEvidence = [
	"# Demo Architecture",
	"",
	"Parse, don't validate: constructors return derived parsed types after protobuf and CUE constraints pass.",
	"The CQRS actor consumes commands, emits events, and appends to the event store.",
	"A materialized view exposes rx-style projection streams with cached snapshots.",
	"Historical snapshots persist in the read store.",
].join("\n");

test("implementationPackageRoots maps production package paths", () => {
	assert.deepEqual(
		implementationPackageRoots([
			"packages/core/src/index.ts",
			"packages/runtimes/runtime-local/src/index.ts",
			"examples/hello-bindle/src/main.ts",
			"docs/design/index.md",
		]),
		["packages/core", "packages/runtimes/runtime-local"],
	);
});

test("implementationPackageRoots ignores barebones examples", () => {
	assert.deepEqual(
		implementationPackageRoots([
			"examples/hello-bindle/src/api.ts",
			"examples/hello-bindle/src/bindle.ts",
		]),
		[],
	);
});

test("architecture guard rejects production packages with misplaced data models and contracts", async () => {
	await withFixture(async (root) => {
		await write(
			root,
			"packages/demo/src/demo.ts",
			"export const demo = true;\n",
		);
		await write(
			root,
			"packages/demo/proto/demo.proto",
			'syntax = "proto3";\nmessage Demo {}\n',
		);
		await write(root, "packages/demo/proto/demo.cue", "Demo: {}\n");
		await write(
			root,
			"packages/demo/pacts/demo.pact.json",
			JSON.stringify({
				consumer: { name: "demo-consumer" },
				provider: { name: "demo-provider" },
				interactions: [],
			}),
		);

		const result = await checkArchitectureGuardrails({
			root,
			files: ["packages/demo/src/demo.ts"],
		});

		const codes = result.problems.map((problem) => problem.code);
		assert.ok(codes.includes("missing-data-models-folder"));
		assert.ok(codes.includes("misplaced-data-model"));
		assert.ok(codes.includes("missing-contracts-pact"));
	});
});

test("architecture guard accepts compliant production packages", async () => {
	await withFixture(async (root) => {
		await write(
			root,
			"packages/demo/src/demo.ts",
			"export const demo = true;\n",
		);
		await write(
			root,
			"packages/demo/data-models/demo.proto",
			'syntax = "proto3";\nmessage Demo {}\n',
		);
		await write(root, "packages/demo/data-models/demo.cue", "Demo: {}\n");
		await write(
			root,
			"packages/demo/contracts/pacts/demo-boundary.pact.json",
			JSON.stringify({
				consumer: { name: "c" },
				provider: { name: "p" },
				interactions: [],
			}),
		);
		await write(root, "packages/demo/ARCHITECTURE.md", architectureEvidence);

		const result = await checkArchitectureGuardrails({
			root,
			files: ["packages/demo/src/demo.ts"],
		});

		assert.deepEqual(result.problems, []);
	});
});

test("architecture guard does not apply production-only checks to draft packages", async () => {
	await withFixture(async (root) => {
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/src/demo.mjs",
			"export const ok = true;\n",
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/contracts/pacts/demo-boundary.pact.json",
			JSON.stringify({
				consumer: { name: "demo-consumer" },
				provider: { name: "demo-provider" },
				interactions: [],
			}),
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/proto/demo.proto",
			'syntax = "proto3";\nmessage Demo {}\n',
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/proto/demo.cue",
			"Demo: {}\n",
		);
		await write(
			root,
			"src/draft/technical-proofs/demo-contract/architecture.md",
			architectureEvidence,
		);

		const result = await checkArchitectureGuardrails({
			root,
			files: ["src/draft/technical-proofs/demo-contract/src/demo.mjs"],
		});

		const codes = result.problems.map((problem) => problem.code);
		assert.equal(codes.includes("missing-data-models-folder"), false);
		assert.equal(codes.includes("misplaced-data-model"), false);
		assert.equal(codes.includes("missing-contracts-pact"), false);
		assert.deepEqual(result.problems, []);
	});
});

test("architecture guard rejects nested npm/yarn/pnpm lockfiles anywhere in the tree", async () => {
	await withFixture(async (root) => {
		const result = await checkArchitectureGuardrails({
			root,
			files: [
				"src/draft/technical-proofs/demo-contract/package-lock.json",
				"packages/core/yarn.lock",
				"src/draft/technical-proofs/demo-contract/pnpm-lock.yaml",
				"pnpm-lock.yaml",
			],
		});

		assert.deepEqual(
			result.problems
				.filter((problem) => problem.code === "single-lockfile")
				.map((problem) => problem.packageRoot),
			[
				"src/draft/technical-proofs/demo-contract/package-lock.json",
				"packages/core/yarn.lock",
				"src/draft/technical-proofs/demo-contract/pnpm-lock.yaml",
			],
		);
	});
});
