import { expect, it } from "vitest";
import { DOCKER_IMAGES } from "../src/docker-images.js";
import { parseDockerCampaignReport } from "../src/docker-report.js";

const { DEPENDENCY_IMAGES, RESTLER_IMAGE, RESTLER_REVISION } = DOCKER_IMAGES;

function report() {
	return {
		fault: {
			latency_ms: 185,
			bandwidth_ms: 795,
			timeout: true,
			reset: true,
			cut: true,
			idempotent: true,
		},
		database: { reset: true, idempotent: true },
		queue: { reset: true, idempotent: true },
		registry: { cut_recovered: true, blob_roundtrip: true },
		restler: {
			coverage: "4 / 4",
			valid: "4 / 4",
			requests: { main_driver: 6, PayloadBodyChecker: 124 },
			bugs: {},
		},
	};
}

it("accepts complete measured fault and RESTler evidence", () => {
	expect(parseDockerCampaignReport(JSON.stringify(report()))).toEqual(report());
});

it.each([
	{ ...report(), fault: { ...report().fault, latency_ms: 1 } },
	{ ...report(), fault: { ...report().fault, bandwidth_ms: 1 } },
	{ ...report(), fault: { ...report().fault, reset: false } },
	{ ...report(), database: { reset: true, idempotent: false } },
	{ ...report(), queue: { reset: false, idempotent: true } },
	{ ...report(), registry: { cut_recovered: true, blob_roundtrip: false } },
	{ ...report(), restler: { ...report().restler, coverage: "3 / 4" } },
	{
		...report(),
		restler: { ...report().restler, requests: { main_driver: 0 } },
	},
	{
		...report(),
		restler: { ...report().restler, requests: { main_driver: -1 } },
	},
	{ ...report(), restler: { ...report().restler, bugs: { response500: 1 } } },
])("rejects incomplete or failed campaign evidence", (invalid) => {
	expect(() => parseDockerCampaignReport(JSON.stringify(invalid))).toThrow();
});

it("pins every downloaded dependency and the RESTler revision", () => {
	for (const image of DEPENDENCY_IMAGES)
		expect(image).toMatch(/@sha256:[a-f0-9]{64}$/u);
	expect(RESTLER_REVISION).toMatch(/^[a-f0-9]{40}$/u);
	expect(RESTLER_IMAGE).toContain(RESTLER_REVISION.slice(0, 16));
});
