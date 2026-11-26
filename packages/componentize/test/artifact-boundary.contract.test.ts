import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	COMPONENT_MEDIA_TYPE,
	componentizeHelloBindle,
	validateWasmComponentArtifact,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pactPath = path.resolve(
	here,
	"../contracts/componentize-artifact-boundary.pact.json",
);
const fixtureRoot = path.resolve(here, "fixtures/hello-bindle");

describe("componentize artifact boundary pact", () => {
	it("is a well-formed pact document", async () => {
		const pact = JSON.parse(await readFile(pactPath, "utf8"));
		expect(pact.consumer.name).toBe("@hobo/cli");
		expect(pact.provider.name).toBe("ComponentizeArtifactBoundary");
		expect(Array.isArray(pact.interactions)).toBe(true);
		expect(pact.interactions.length).toBeGreaterThan(0);
	});

	it("provider honors the componentize interaction", async () => {
		const pact = JSON.parse(await readFile(pactPath, "utf8"));
		const build = pact.interactions.find(
			(interaction: { request: { path: string } }) =>
				interaction.request.path.endsWith("/hello-bindle"),
		);
		const result = await componentizeHelloBindle({
			sourceRoot: fixtureRoot,
			sourceDateEpoch: "2026-01-01T00:00:00Z",
		});
		expect(result.component.mediaType).toBe(build.response.body.mediaType);
		expect(result.component.mediaType).toBe(COMPONENT_MEDIA_TYPE);
		expect(result.component.witWorld).toBe(build.response.body.witWorld);
	});

	it("provider honors the validate interaction", async () => {
		const pact = JSON.parse(await readFile(pactPath, "utf8"));
		const validate = pact.interactions.find(
			(interaction: { request: { path: string } }) =>
				interaction.request.path.endsWith("/validate"),
		);
		const result = await componentizeHelloBindle({
			sourceRoot: fixtureRoot,
			sourceDateEpoch: "2026-01-01T00:00:00Z",
		});
		const verdict = validateWasmComponentArtifact(result.component);
		expect(verdict.passed).toBe(validate.response.body.passed);
		expect(verdict.format).toBe(validate.response.body.format);
	});
});
