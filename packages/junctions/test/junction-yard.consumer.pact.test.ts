import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { deriveConnectivityPlan, junction, planForYard } from "../src/index.js";
import { makeYard } from "./helpers.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"pacts",
	"junction-yard-membership.pact.json",
);

describe("junctions → yards membership pact", () => {
	it("pins the junction↔yard boundary: parsed Yards in, per-yard halves out", () => {
		const aws = makeYard("aws", "aws");
		const azure = makeYard("azure", "azure");
		const definition = junction("my-app", { yards: [aws, azure] });
		const plan = deriveConnectivityPlan(definition);
		const awsHalf = planForYard(plan, "aws");

		const pact = {
			consumer: { name: "@hobo/junctions" },
			provider: { name: "@hobo/yards" },
			interactions: [
				{
					description:
						"junction accepts parsed Yard objects and composes a junction definition",
					request: {
						method: "POST",
						path: "/junctions/compose",
						body: {
							name: "my-app",
							yards: [
								{ kind: "yard", name: "aws", providerId: "aws" },
								{ kind: "yard", name: "azure", providerId: "azure" },
							],
						},
					},
					response: {
						status: 200,
						body: {
							kind: "junction",
							name: "my-app",
							members: ["aws", "azure"],
						},
					},
				},
				{
					description:
						"each member yard can extract its own half of the derived plan",
					request: {
						method: "GET",
						path: "/junctions/my-app/plan/aws",
					},
					response: {
						status: 200,
						body: {
							yardName: "aws",
							halves: awsHalf.halves,
							dnsRecordsToRealize: awsHalf.dnsRecordsToRealize,
						},
					},
				},
			],
			metadata: { pactSpecification: { version: "3.0.0" } },
		};

		writeFileSync(pactPath, `${JSON.stringify(pact, null, 2)}\n`, "utf8");

		const written = JSON.parse(readFileSync(pactPath, "utf8"));
		expect(written.consumer.name).toBe("@hobo/junctions");
		expect(written.provider.name).toBe("@hobo/yards");
		expect(written.interactions).toHaveLength(2);
		expect(definition.members.map((member) => member.yardName)).toEqual([
			"aws",
			"azure",
		]);
		expect(awsHalf.halves.every((half) => half.yardName === "aws")).toBe(true);
	});
});
