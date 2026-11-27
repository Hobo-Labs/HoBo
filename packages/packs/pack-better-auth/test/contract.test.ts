import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBetterAuthConfig } from "@hobo/auth-adapter-contract";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "@hobo/auth-adapter-contract/json";
import { MIGRATION_PLAN_CONTRACT, SCHEMA_IR_CONTRACT } from "@hobo/core";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	BetterAuthBundlePlanError,
	campSecretNameFromBetterAuthRef,
	planBetterAuthBundle,
	planBetterAuthRelationalMigrations,
	wireBetterAuthSigningSecret,
} from "../src/index.js";

type BundlePlanPactCase = {
	readonly description: string;
	readonly expectSuccess: boolean;
	readonly configInput: JsonObject;
	readonly portsInput: JsonObject;
	readonly forExecution: boolean;
	readonly expectedPackId?: string;
	readonly expectedDescriptorId?: string;
	readonly expectedClaimsVersion?: string;
	readonly expectedRoutePattern?: string;
	readonly expectedErrorCode?: string;
};

type MigrationPactCase = {
	readonly description: string;
	readonly expectedPlanContract: string;
	readonly expectedPhases: readonly string[];
	readonly expectedTables: readonly string[];
};

type SigningPactCase = {
	readonly description: string;
	readonly expectSuccess: boolean;
	readonly secretRef: string;
	readonly expectedSecretRef?: string;
	readonly expectedSecretScheme?: string;
	readonly expectedErrorCode?: string;
};

const SYNTHETIC_SIGNING =
	"synthetic-better-auth-signing-secret-0123456789abcdef0123456789ab";

const contractsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../contracts",
);

function malformed(detail: string): never {
	throw new Error(`malformed pact interaction: ${detail}`);
}

function parsePortRefs(value: JsonObject): JsonObject {
	const relationalBindle = value.relationalBindle;
	const httpBindle = value.httpBindle;
	const signingSecretRef = value.signingSecretRef;
	if (
		!isJsonString(relationalBindle) ||
		!isJsonString(httpBindle) ||
		!isJsonString(signingSecretRef)
	) {
		malformed("ports must be strings");
	}
	return Object.freeze({ relationalBindle, httpBindle, signingSecretRef });
}

function parsePackPactCases(text: string): readonly BundlePlanPactCase[] {
	const root = parseJsonValue(text);
	if (!isJsonObject(root)) throw new Error("pact must be a JSON object");
	const interactions = root.interactions;
	if (!isJsonArray(interactions))
		throw new Error("interactions must be an array");
	const cases: BundlePlanPactCase[] = [];
	for (const entry of interactions) {
		if (!isJsonObject(entry)) malformed("interaction must be an object");
		const description = entry.description;
		const request = entry.request;
		const response = entry.response;
		if (
			!isJsonString(description) ||
			!isJsonObject(request) ||
			!isJsonObject(response)
		) {
			malformed("interaction is missing description, request, or response");
		}
		const body = request.body;
		const responseBody = response.body;
		const status = response.status;
		if (
			!isJsonObject(body) ||
			!isJsonObject(responseBody) ||
			!isJsonNumber(status)
		) {
			malformed("interaction body or status is missing");
		}
		const configInput = body.configInput;
		const portsInput = body.ports;
		if (!isJsonObject(configInput) || !isJsonObject(portsInput)) {
			malformed("interaction configInput or ports is missing");
		}
		parsePortRefs(portsInput);
		const optionsInput = body.options;
		let forExecution = false;
		if (
			isJsonObject(optionsInput) &&
			isJsonBoolean(optionsInput.forExecution)
		) {
			forExecution = optionsInput.forExecution;
		}
		if (status === 200) {
			const packId = responseBody.packId;
			const descriptorId = responseBody.descriptorId;
			const claimsMappingVersion = responseBody.claimsMappingVersion;
			const routePattern = responseBody.routePattern;
			if (
				!isJsonString(packId) ||
				!isJsonString(descriptorId) ||
				!isJsonString(claimsMappingVersion) ||
				!isJsonString(routePattern)
			) {
				malformed("success response is missing plan fields");
			}
			cases.push({
				description,
				expectSuccess: true,
				configInput,
				portsInput,
				forExecution,
				expectedPackId: packId,
				expectedDescriptorId: descriptorId,
				expectedClaimsVersion: claimsMappingVersion,
				expectedRoutePattern: routePattern,
			});
			continue;
		}
		const code = responseBody.code;
		if (!isJsonString(code)) malformed("failure response is missing code");
		cases.push({
			description,
			expectSuccess: false,
			configInput,
			portsInput,
			forExecution,
			expectedErrorCode: code,
		});
	}
	return Object.freeze(cases);
}

function parseMigrationPactCases(text: string): readonly MigrationPactCase[] {
	const root = parseJsonValue(text);
	if (!isJsonObject(root)) throw new Error("pact must be a JSON object");
	const interactions = root.interactions;
	if (!isJsonArray(interactions)) {
		throw new Error("interactions must be an array");
	}
	const cases: MigrationPactCase[] = [];
	for (const entry of interactions) {
		if (!isJsonObject(entry)) malformed("interaction must be an object");
		const description = entry.description;
		const response = entry.response;
		if (!isJsonString(description) || !isJsonObject(response)) {
			malformed("interaction is missing description or response");
		}
		const responseBody = response.body;
		const status = response.status;
		if (!isJsonObject(responseBody) || !isJsonNumber(status)) {
			malformed("interaction response body or status is missing");
		}
		if (status !== 200) {
			malformed("relational migration pact expects success responses");
		}
		const planContract = responseBody.planContract;
		const phases = responseBody.phases;
		const tables = responseBody.tables;
		if (
			!isJsonString(planContract) ||
			!isJsonArray(phases) ||
			!isJsonArray(tables)
		) {
			malformed(
				"migration response is missing planContract, phases, or tables",
			);
		}
		const parsedPhases = phases.filter((phase) => isJsonString(phase));
		const parsedTables = tables.filter((table) => isJsonString(table));
		if (
			parsedPhases.length !== phases.length ||
			parsedTables.length !== tables.length
		) {
			malformed("migration phases and tables must be strings");
		}
		cases.push({
			description,
			expectedPlanContract: planContract,
			expectedPhases: Object.freeze(parsedPhases),
			expectedTables: Object.freeze(parsedTables),
		});
	}
	return Object.freeze(cases);
}

function parseSigningPactCases(text: string): readonly SigningPactCase[] {
	const root = parseJsonValue(text);
	if (!isJsonObject(root)) throw new Error("pact must be a JSON object");
	const interactions = root.interactions;
	if (!isJsonArray(interactions)) {
		throw new Error("interactions must be an array");
	}
	const cases: SigningPactCase[] = [];
	for (const entry of interactions) {
		if (!isJsonObject(entry)) malformed("interaction must be an object");
		const description = entry.description;
		const request = entry.request;
		const response = entry.response;
		if (
			!isJsonString(description) ||
			!isJsonObject(request) ||
			!isJsonObject(response)
		) {
			malformed("interaction is missing description, request, or response");
		}
		const body = request.body;
		const responseBody = response.body;
		const status = response.status;
		if (
			!isJsonObject(body) ||
			!isJsonObject(responseBody) ||
			!isJsonNumber(status)
		) {
			malformed("interaction body or status is missing");
		}
		const secretRef = body.secretRef;
		if (!isJsonString(secretRef)) {
			malformed("signing pact request is missing secretRef");
		}
		if (status === 200) {
			const expectedSecretRef = responseBody.secretRef;
			const expectedSecretScheme = responseBody.secretScheme;
			if (
				!isJsonString(expectedSecretRef) ||
				!isJsonString(expectedSecretScheme)
			) {
				malformed(
					"success signing response is missing secretRef or secretScheme",
				);
			}
			cases.push({
				description,
				expectSuccess: true,
				secretRef,
				expectedSecretRef,
				expectedSecretScheme,
			});
			continue;
		}
		const code = responseBody.code;
		if (!isJsonString(code)) malformed("failure response is missing code");
		cases.push({
			description,
			expectSuccess: false,
			secretRef,
			expectedErrorCode: code,
		});
	}
	return Object.freeze(cases);
}

function assertInteractionCount(
	pactPath: string,
	cases: readonly unknown[],
): void {
	const root = parseJsonValue(readFileSync(pactPath, "utf8"));
	if (!isJsonObject(root) || !isJsonArray(root.interactions)) {
		throw new Error("pact interactions missing");
	}
	expect(cases.length).toBe(root.interactions.length);
}

const bundlePlanPactFile = join(
	contractsDir,
	"pack-better-auth-bundle-plan.pact.json",
);
const bundlePlanPactCases = parsePackPactCases(
	readFileSync(bundlePlanPactFile, "utf8"),
);

const migrationPactFile = join(
	contractsDir,
	"pack-better-auth-relational-migrations.pact.json",
);
const migrationPactCases = parseMigrationPactCases(
	readFileSync(migrationPactFile, "utf8"),
);

const signingPactFile = join(
	contractsDir,
	"pack-better-auth-signing-secret-broker.pact.json",
);
const signingPactCases = parseSigningPactCases(
	readFileSync(signingPactFile, "utf8"),
);

describe("pack-better-auth-bundle-plan pact", () => {
	it("loads every interaction from the pact file", () => {
		assertInteractionCount(bundlePlanPactFile, bundlePlanPactCases);
		expect(bundlePlanPactCases.length).toBe(2);
	});

	it("throws on a malformed interaction", () => {
		expect(() =>
			parsePackPactCases(
				JSON.stringify({
					interactions: [{ description: "broken" }],
				}),
			),
		).toThrow(/malformed pact interaction/u);
	});

	for (const pactCase of bundlePlanPactCases) {
		it(pactCase.description, () => {
			if (pactCase.expectSuccess) {
				const plan = planBetterAuthBundle(
					pactCase.configInput,
					pactCase.portsInput,
					{ forExecution: pactCase.forExecution },
				);
				expect(plan.packId).toBe(pactCase.expectedPackId);
				expect(plan.descriptorId).toBe(pactCase.expectedDescriptorId);
				expect(plan.claimsMappingVersion).toBe(pactCase.expectedClaimsVersion);
				expect(plan.routePattern).toBe(pactCase.expectedRoutePattern);
				return;
			}
			const run = () =>
				planBetterAuthBundle(pactCase.configInput, pactCase.portsInput);
			expect(run).toThrow(BetterAuthBundlePlanError);
			try {
				run();
			} catch (error) {
				expect(error).toBeInstanceOf(BetterAuthBundlePlanError);
				if (!(error instanceof BetterAuthBundlePlanError)) throw error;
				expect(error.code).toBe(pactCase.expectedErrorCode);
			}
		});
	}
});

describe("pack-better-auth-relational-migrations pact", () => {
	it("loads every interaction from the pact file", () => {
		assertInteractionCount(migrationPactFile, migrationPactCases);
		expect(migrationPactCases.length).toBe(1);
	});

	it("throws on a malformed interaction", () => {
		expect(() =>
			parseMigrationPactCases(
				JSON.stringify({
					interactions: [{ description: "broken" }],
				}),
			),
		).toThrow(/malformed pact interaction/u);
	});

	for (const pactCase of migrationPactCases) {
		it(pactCase.description, () => {
			const secretRef = "hobo-secret://camp-prod/auth/better-auth-signing-key";
			const configInput: JsonObject = {
				basePath: "/api/auth",
				secretRef,
				database: { profile: "data.relational/v1" },
			};
			const portsInput: JsonObject = {
				relationalBindle: "auth_db",
				httpBindle: "auth_api",
				signingSecretRef: secretRef,
			};
			const bundlePlan = planBetterAuthBundle(configInput, portsInput);
			const wire = planBetterAuthRelationalMigrations(bundlePlan, {
				currentSchema: {
					contract: SCHEMA_IR_CONTRACT,
					dialect: "postgres",
					tables: [],
				},
			});
			expect(wire.migrationPlan.contract).toBe(pactCase.expectedPlanContract);
			expect(wire.migrationPlan.contract).toBe(MIGRATION_PLAN_CONTRACT);
			expect(
				wire.migrationPlan.steps.every(
					(step) => step.phase === pactCase.expectedPhases[0],
				),
			).toBe(true);
			const createdTables = wire.migrationPlan.steps
				.filter((step) => step.kind === "create-table")
				.map((step) => step.table)
				.sort();
			expect(createdTables).toEqual([...pactCase.expectedTables].sort());
		});
	}
});

describe("pack-better-auth-signing-secret-broker pact", () => {
	it("loads every interaction from the pact file", () => {
		assertInteractionCount(signingPactFile, signingPactCases);
		expect(signingPactCases.length).toBe(2);
	});

	it("throws on a malformed interaction", () => {
		expect(() =>
			parseSigningPactCases(
				JSON.stringify({
					interactions: [{ description: "broken" }],
				}),
			),
		).toThrow(/malformed pact interaction/u);
	});

	for (const pactCase of signingPactCases) {
		it(pactCase.description, async () => {
			const configInput: JsonObject = {
				basePath: "/api/auth",
				secretRef: pactCase.secretRef,
				database: { profile: "data.relational/v1" },
			};
			const portsInput: JsonObject = {
				relationalBindle: "auth_db",
				httpBindle: "auth_api",
				signingSecretRef: pactCase.secretRef,
			};
			const bundlePlan = planBetterAuthBundle(configInput, portsInput);
			const port = createMemorySecretsPort({ id: "secrets:pact-fixture" });
			if (pactCase.expectSuccess) {
				const name = campSecretNameFromBetterAuthRef(
					parseBetterAuthConfig(configInput).secretRef,
					"camp-prod",
				);
				await port.put(name, SYNTHETIC_SIGNING);
				const wire = await wireBetterAuthSigningSecret(bundlePlan, port, {
					campAuthority: "camp-prod",
					now: "2026-11-25T00:00:00.000Z",
				});
				expect(wire.secretRef).toBe(pactCase.expectedSecretRef);
				expect(wire.secretScheme).toBe(pactCase.expectedSecretScheme);
				expect(JSON.stringify(wire)).not.toContain(SYNTHETIC_SIGNING);
				return;
			}
			await expect(
				wireBetterAuthSigningSecret(bundlePlan, port, {
					campAuthority: "camp-prod",
				}),
			).rejects.toMatchObject({
				code: pactCase.expectedErrorCode,
			});
		});
	}
});
