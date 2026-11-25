import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "@hobo/auth-adapter-contract/json";

import {
	BetterAuthBundlePlanError,
	type BetterAuthBundlePortRefs,
	planBetterAuthBundle,
} from "../src/index.js";

type PactCase = {
	readonly description: string;
	readonly expectSuccess: boolean;
	readonly configInput: JsonObject;
	readonly ports: BetterAuthBundlePortRefs;
	readonly forExecution: boolean;
	readonly expectedPackId?: string;
	readonly expectedDescriptorId?: string;
	readonly expectedClaimsVersion?: string;
	readonly expectedRoutePattern?: string;
};

function parsePortRefs(value: JsonObject): BetterAuthBundlePortRefs | null {
	const relationalBindle = value.relationalBindle;
	const httpBindle = value.httpBindle;
	const signingSecretRef = value.signingSecretRef;
	if (
		!isJsonString(relationalBindle) ||
		!isJsonString(httpBindle) ||
		!isJsonString(signingSecretRef)
	) {
		return null;
	}
	return Object.freeze({ relationalBindle, httpBindle, signingSecretRef });
}

function parsePackPactCases(text: string): readonly PactCase[] {
	const root = parseJsonValue(text);
	if (!isJsonObject(root)) throw new Error("pact must be a JSON object");
	const interactions = root.interactions;
	if (!isJsonArray(interactions)) throw new Error("interactions must be an array");
	const cases: PactCase[] = [];
	for (const entry of interactions) {
		if (!isJsonObject(entry)) continue;
		const description = entry.description;
		const request = entry.request;
		const response = entry.response;
		if (
			!isJsonString(description) ||
			!isJsonObject(request) ||
			!isJsonObject(response)
		) {
			continue;
		}
		const body = request.body;
		const responseBody = response.body;
		const status = response.status;
		if (
			!isJsonObject(body) ||
			!isJsonObject(responseBody) ||
			!isJsonNumber(status)
		) {
			continue;
		}
		const configInput = body.configInput;
		const portsInput = body.ports;
		if (!isJsonObject(configInput) || !isJsonObject(portsInput)) continue;
		const ports = parsePortRefs(portsInput);
		if (ports === null) continue;
		const optionsInput = body.options;
		let forExecution = false;
		if (isJsonObject(optionsInput) && isJsonBoolean(optionsInput.forExecution)) {
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
				continue;
			}
			cases.push({
				description,
				expectSuccess: true,
				configInput,
				ports,
				forExecution,
				expectedPackId: packId,
				expectedDescriptorId: descriptorId,
				expectedClaimsVersion: claimsMappingVersion,
				expectedRoutePattern: routePattern,
			});
			continue;
		}
		cases.push({
			description,
			expectSuccess: false,
			configInput,
			ports,
			forExecution,
		});
	}
	return Object.freeze(cases);
}

const pactFile = join(
	dirname(fileURLToPath(import.meta.url)),
	"../contracts/pack-better-auth-bundle-plan.pact.json",
);
const pactCases = parsePackPactCases(readFileSync(pactFile, "utf8"));

describe("pack-better-auth-bundle-plan pact", () => {
	it("loads every interaction from the pact file", () => {
		expect(pactCases.length).toBeGreaterThan(0);
	});

	for (const pactCase of pactCases) {
		it(pactCase.description, () => {
			if (pactCase.expectSuccess) {
				const plan = planBetterAuthBundle(
					pactCase.configInput,
					pactCase.ports,
					{ forExecution: pactCase.forExecution },
				);
				expect(plan.packId).toBe(pactCase.expectedPackId);
				expect(plan.descriptorId).toBe(pactCase.expectedDescriptorId);
				expect(plan.claimsMappingVersion).toBe(pactCase.expectedClaimsVersion);
				expect(plan.routePattern).toBe(pactCase.expectedRoutePattern);
				return;
			}
			expect(() =>
				planBetterAuthBundle(pactCase.configInput, pactCase.ports),
			).toThrow(BetterAuthBundlePlanError);
		});
	}
});