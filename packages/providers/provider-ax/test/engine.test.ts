import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	parseTrainingArtifactProgram,
	TrainingEngineParseError,
} from "@hobo/core";
import { test } from "vitest";

import { createAxTrainingEngine } from "../src/index.js";
import { mockModel, optimizeRequest, trajectory } from "./helpers.js";

const TRAJECTORIES = [
	trajectory("t1", "cannot reset password", "access", 0.95),
	trajectory("t2", "site is down", "outage", 0.97),
	trajectory("t3", "weird gibberish", "other", 0.2),
];

test("optimize returns a provenance-pinned artifact candidate", async () => {
	const engine = createAxTrainingEngine({
		ai: mockModel("access"),
		maxMetricCalls: 8,
	});

	const candidate = await engine.optimize(
		// SAFETY: test fixture is a wire-shaped OptimizeRequest; the engine re-parses.
		optimizeRequest(TRAJECTORIES) as never,
	);

	assert.equal(candidate.body.case, "artifact");
	if (candidate.body.case !== "artifact") return;
	const artifact = candidate.body.value;
	assert.equal(artifact.engineId, engine.engineId);
	assert.equal(artifact.methodRef, "classifyTicket");
	assert.match(artifact.engineVersion, /^\d+\.\d+\.\d+/);

	// The program is the platform-normalized shape; only high-reward
	// trajectories (t1, t2) qualify as demos.
	const program = parseTrainingArtifactProgram(artifact.programJson);
	assert.equal(program.demos.length, 2);

	assert.equal(candidate.provenance?.trajectoryHashes.length, 3);
	assert.equal(
		candidate.provenance?.rubricRef,
		"rubric://support/classifier@1.0.0",
	);
});

test("optimize is deterministic for the same request (stable provenance)", async () => {
	const engine = createAxTrainingEngine({
		ai: mockModel("access"),
		maxMetricCalls: 8,
	});
	const first = await engine.optimize(
		// SAFETY: test fixture is a wire-shaped OptimizeRequest; the engine re-parses.
		optimizeRequest(TRAJECTORIES) as never,
	);
	const second = await engine.optimize(
		// SAFETY: test fixture is a wire-shaped OptimizeRequest; the engine re-parses.
		optimizeRequest(TRAJECTORIES) as never,
	);
	assert.deepEqual(
		JSON.parse(JSON.stringify(first.provenance)),
		JSON.parse(JSON.stringify(second.provenance)),
	);
	assert.equal(first.id, second.id);
});

test("optimize parses its boundary and rejects malformed requests", async () => {
	const engine = createAxTrainingEngine({ ai: mockModel("access") });
	await assert.rejects(
		// SAFETY: empty requestId is the malformed-input case; the engine re-parses.
		engine.optimize({ requestId: "" } as never),
		TrainingEngineParseError,
	);
});

test("the engine version constant matches the installed ax package", () => {
	const installedJson: { version?: string } = JSON.parse(
		readFileSync(
			new URL("../node_modules/@ax-llm/ax/package.json", import.meta.url),
			"utf8",
		),
	);
	const installed = { version: String(installedJson.version ?? "") };
	// AX_ENGINE_VERSION is engine-internal; it surfaces on every artifact.
	// Re-derive it from an emitted candidate to avoid exporting the constant.
	return createAxTrainingEngine({ ai: mockModel("access"), maxMetricCalls: 4 })
		.optimize(
			// SAFETY: test fixture is a wire-shaped OptimizeRequest; the engine re-parses.
			optimizeRequest(TRAJECTORIES) as never,
		)
		.then((candidate) => {
			assert.equal(candidate.body.case, "artifact");
			if (candidate.body.case === "artifact") {
				assert.equal(candidate.body.value.engineVersion, installed.version);
			}
		});
});
