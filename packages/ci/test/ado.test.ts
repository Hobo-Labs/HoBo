import { readFile } from "node:fs/promises";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ConfigurationSchema } from "../src/_generated/ci_pb.js";
import { parseConfiguration } from "../src/config.js";
import { parseCiPolicy } from "../src/policy.js";

async function configuration() {
	return fromJsonString(
		ConfigurationSchema,
		await readFile(
			new URL(
				"../data-models/fixtures/valid/configuration-ado.json",
				import.meta.url,
			),
			"utf8",
		),
	);
}
describe("Azure DevOps CI policy boundary", () => {
	it("accepts ADO only with its matching native execution backend", async () => {
		const config = await configuration();
		expect(
			parseConfiguration(toJsonString(ConfigurationSchema, config)).accounts[0]
				?.offers[0]?.backend,
		).toBe("ado");
	});
	it.each([
		["azure-devops", "gh-actions"],
		["github", "ado"],
	])("rejects mismatched %s/%s", async (provider, backend) => {
		const config = await configuration();
		const offer = config.accounts[0]?.offers[0];
		if (!offer) throw new Error("fixture missing offer");
		offer.provider = provider;
		offer.backend = backend;
		expect(() =>
			parseConfiguration(toJsonString(ConfigurationSchema, config)),
		).toThrow(/matching execution backend/);
	});
	it("accepts Station-owned ADO connections in desired policy", async () => {
		const policy = parseCiPolicy(
			await readFile(
				new URL(
					"../data-models/fixtures/valid/desired-policy-ado.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect(policy.providers[0]).toMatchObject({
			kind: "azure-devops",
			connectionRef: "ado-pool",
			runsOn: "hobo-local",
		});
	});
});
