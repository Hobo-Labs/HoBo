import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	checkPactInventory,
	parsePactDocument,
	verifyPact,
} from "@hobo/contract-harness";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
} from "@hobo/data-core";
import { expect, it } from "vitest";
import {
	createTestHarness,
	isTestHarnessError,
	parseTestTopology,
	teardownOrder,
} from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

it("verifies the in-process harness consumer pact against its actual functions", async () => {
	expect(
		await checkPactInventory(
			fileURLToPath(new URL("../contracts", import.meta.url)),
		),
	).toEqual({ ok: true, problems: [] });
	const pact = parsePactDocument(
		JSON.parse(
			await readFile(
				new URL(
					"../contracts/pacts/app-test-harness.pact.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);
	const verification = await verifyPact(pact, {
		name: "HoboAppTestHarness",
		async handle(request) {
			const body = isJsonObject(request.body) ? request.body : {};
			try {
				if (
					request.method === "POST" &&
					request.path === "/harness/deploy" &&
					body.lane === "ephemeral-camp"
				) {
					createTestHarness(
						{ lane: "ephemeral-camp", yard: body.yard },
						{
							env: {
								VITEST: "true",
								...(body.yard === undefined
									? undefined
									: {
											HOBO_TESTING_CAMP_CREDENTIAL_REF:
												"synthetic-pasted-value",
										}),
							},
						},
					);
					return { status: 200 };
				}
				if (
					request.method === "POST" &&
					request.path === "/harness/until-ready" &&
					isJsonString(body.target) &&
					isJsonNumber(body.observedStatus)
				) {
					const status = body.observedStatus;
					const harness = createTestHarness(
						{},
						{ probe: async () => ({ status }) },
					);
					await harness.untilReady(body.target);
					return { status: 200 };
				}
				if (
					(request.method === "POST" &&
						request.path === "/harness/deploy" &&
						body.lane === "in-process" &&
						body.bindle === "demo" &&
						isJsonString(body.stage)) ||
					(request.method === "GET" && request.path === "/harness/fidelity")
				) {
					const stage = isJsonString(body.stage) ? body.stage : "test";
					const harness = createTestHarness({ stage });
					const bindle = fakeBindle();
					const graph = await harness.deploy(bindle)();
					try {
						if (request.path === "/harness/fidelity") {
							if (!isJsonArray(body.assertedAgainst)) return { status: 400 };
							for (const alias of body.assertedAgainst) {
								if (!isJsonString(alias)) return { status: 400 };
								graph.resource(alias);
							}
							const report = graph.fidelity();
							return {
								status: 200,
								body: {
									by_fidelity: report.byFidelity,
									asserted_against: report.assertedAgainst,
									prod_readiness_claimable: report.prodReadinessClaimable,
								},
							};
						}
						const deploymentReport = graph.fidelity();
						const handles = ["api", "cache", "db"].map((alias) =>
							graph.resource(alias),
						);
						return {
							status: 200,
							body: {
								contract: "hobo.test-harness/v1",
								stage: graph.stage,
								lane: graph.lane,
								handles,
								fidelity: {
									by_fidelity: deploymentReport.byFidelity,
									asserted_against: deploymentReport.assertedAgainst,
									prod_readiness_claimable:
										deploymentReport.prodReadinessClaimable,
								},
								teardown_order: teardownOrder(parseTestTopology(bindle)),
							},
						};
					} finally {
						await harness.destroy(bindle)();
					}
				}
				return { status: 404 };
			} catch (error) {
				if (!isTestHarnessError(error)) throw error;
				return {
					status: error.code === "HARNESS_CREDENTIAL_NOT_A_REF" ? 422 : 409,
					body: {
						code: error.code,
						message: error.message,
						remediation: error.remediation,
					},
				};
			}
		},
	});
	expect(verification).toEqual({
		providerName: "HoboAppTestHarness",
		ok: true,
		failures: [],
	});
});
