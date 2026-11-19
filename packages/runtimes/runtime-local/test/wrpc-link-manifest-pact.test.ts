import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromJson, toJson } from "@bufbuild/protobuf";
import {
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
	WireVersionIncompatibleError,
	WrpcLinkManifestSchema,
} from "@hobo/core";
import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { expect, it } from "vitest";
import { createInProcessTransport, createWrpcLinkLayer } from "../src/index.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../src/json.js";

const pactPath = fileURLToPath(
	new URL("../contracts/pacts/wrpc-link-manifest.pact.json", import.meta.url),
);

function object(value: JsonValue | undefined): JsonObject {
	if (!isJsonObject(value)) throw new TypeError("expected an object");
	return value;
}

function string(value: JsonValue | undefined): string {
	if (!isJsonString(value)) throw new TypeError("expected a string");
	return value;
}

function versions(value: JsonValue | undefined) {
	if (!Array.isArray(value)) throw new TypeError("expected versions");
	return value.map((entry) => parseWireVersion(string(entry)));
}

function content(value: JsonValue | undefined): JsonValue {
	const contents = object(object(value).contents);
	if (
		contents.contentType !== "application/json" ||
		contents.content === undefined
	)
		throw new TypeError("expected JSON pact content");
	return contents.content;
}

function interactions() {
	const pact = object(parseJsonValue(readFileSync(pactPath, "utf8")));
	if (!Array.isArray(pact.interactions) || pact.interactions.length === 0)
		throw new TypeError("expected pact interactions");
	return pact.interactions.map((value) => {
		const interaction = object(value);
		if (
			interaction.type !== "Synchronous/Messages" ||
			!Array.isArray(interaction.response) ||
			interaction.response.length !== 1
		)
			throw new TypeError("expected one synchronous pact response");
		return {
			description: string(interaction.description),
			request: content(interaction.request),
			response: content(interaction.response[0]),
		};
	});
}

function manifestForScenario(value: JsonValue) {
	const scenario = object(value);
	const componentId = string(scenario.componentId);
	const providerId = string(scenario.providerId);
	const interfaceId = parseInterfaceId(string(scenario.interfaceId));
	const store = new ProviderHandlerStore();
	const layer = createWrpcLinkLayer({
		store,
		transport: createInProcessTransport({ store }),
		compatibilityFloor: string(scenario.floor),
	});
	layer.registerComponent({
		id: componentId,
		imports: [
			{
				interfaceId,
				stability: "stable",
				versions: versions(scenario.callerVersions),
			},
		],
	});
	layer.registerProvider({
		id: providerId,
		exports: [
			{
				interfaceId,
				stability: "stable",
				versions: versions(scenario.providerVersions),
			},
		],
		handlers: { [interfaceId]: { get: () => ({ value: "ok" }) } },
	});
	try {
		layer.establishLink({
			componentId,
			providerId,
			importInterface: interfaceId,
			exportInterface: interfaceId,
		});
	} catch (error) {
		if (!(error instanceof WireVersionIncompatibleError)) throw error;
	}
	return layer.manifestIr();
}

it("reads runtime manifests through the protobuf consumer contract", () => {
	const contracts = interactions();
	expect(contracts).toHaveLength(2);
	for (const contract of contracts) {
		const manifest = manifestForScenario(contract.request);
		const decoded = fromJson(WrpcLinkManifestSchema, contract.response);
		expect(
			toJson(WrpcLinkManifestSchema, decoded, { alwaysEmitImplicit: true }),
		).toEqual(manifest);
	}
});

it("verifies every manifest interaction against the runtime provider", async () => {
	const contracts = interactions();
	const verified = new Set<string>();
	const invoke = (message: MessageDescriptor) => {
		if (message.content === undefined || Buffer.isBuffer(message.content))
			throw new TypeError("expected a JSON pact request");
		verified.add(message.description);
		return cloneAsJson(
			manifestForScenario(parseJsonValue(JSON.stringify(message.content))),
		);
	};
	await new Verifier({
		provider: "RuntimeLocalWrpcLinks",
		pactUrls: [pactPath],
		messageProviders: Object.fromEntries(
			contracts.map(({ description }) => [description, invoke]),
		),
		logLevel: "error",
		failIfNoPactsFound: true,
	}).verifyProvider();
	expect([...verified].sort()).toEqual(
		contracts.map(({ description }) => description).sort(),
	);
}, 30_000);
