import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromJson, toJson } from "@bufbuild/protobuf";
import { parsePactDocument } from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";
import {
	AvailabilityViewRequestSchema,
	AvailabilityViewSchema,
} from "../src/_generated/availability_view_pb.js";
import {
	computeAvailabilityView,
	parseAvailabilityViewRequest,
} from "../src/availability-view.js";
import { parseJsonValue } from "../src/json.js";

const cueFile = fileURLToPath(
	new URL("../data-models/availability_view.cue", import.meta.url),
);
const pact = parsePactDocument(
	parseJsonValue(
		readFileSync(
			new URL(
				"../contracts/pacts/availability-view.pact.json",
				import.meta.url,
			),
			"utf8",
		),
	),
);

function cueVet(definition: string, value: string) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-availability-cue-"));
	try {
		const fixture = join(directory, "value.json");
		writeFileSync(fixture, value);
		const result = spawnSync(
			"cue",
			["vet", cueFile, fixture, "-d", definition, "-c"],
			{
				encoding: "utf8",
			},
		);
		if (result.error) throw result.error;
		return { status: result.status, stderr: result.stderr };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("availability wire and CUE contracts", () => {
	it("validates and round-trips each real estimator request and response", () => {
		for (const interaction of pact.interactions) {
			const input = parseJsonValue(
				JSON.stringify(interaction.request.body ?? null),
			);
			const requestWire = fromJson(AvailabilityViewRequestSchema, input);
			const request = parseAvailabilityViewRequest(
				toJson(AvailabilityViewRequestSchema, requestWire),
			);
			const view = computeAvailabilityView(request);
			const requestCheck = cueVet(
				"#AvailabilityViewRequest",
				JSON.stringify(input),
			);
			const viewCheck = cueVet("#AvailabilityView", JSON.stringify(view));
			expect(requestCheck.status, requestCheck.stderr).toBe(0);
			expect(viewCheck.status, viewCheck.stderr).toBe(0);
			const wire = fromJson(
				AvailabilityViewSchema,
				parseJsonValue(JSON.stringify(view)),
			);
			const decoded = fromJson(
				AvailabilityViewSchema,
				toJson(AvailabilityViewSchema, wire),
			);
			expect(decoded.status).toBe(view.status);
			expect(decoded.estimatedAvailability ?? null).toBe(
				view.estimatedAvailability,
			);
		}
	});

	it("rejects an availability outside the supported range", () => {
		const request = {
			graph: { root: "api", nodes: { api: { availability: 1.1 } } },
		};
		const check = cueVet("#AvailabilityViewRequest", JSON.stringify(request));
		expect(check.status).not.toBe(0);
	});

	it("rejects component-only fields on a redundant set", () => {
		const request = {
			graph: {
				root: "pair",
				nodes: {
					pair: { type: "redundant-set", members: ["a"], availability: 0.5 },
					a: { availability: 0.99 },
				},
			},
		};
		const check = cueVet("#AvailabilityViewRequest", JSON.stringify(request));
		expect(check.status).not.toBe(0);
	});
});
