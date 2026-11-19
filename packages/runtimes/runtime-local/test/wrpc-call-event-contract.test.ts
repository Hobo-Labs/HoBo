import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import {
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
	WrpcCallEventSchema,
} from "@hobo/core";
import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { expect, it } from "vitest";
import {
	createInProcessTransport,
	createWrpcLinkLayer,
	DeadlineExceededError,
} from "../src/index.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../src/json.js";

const pactPath = fileURLToPath(
	new URL("../contracts/pacts/wrpc-call-event.pact.json", import.meta.url),
);
const cueFile = fileURLToPath(
	new URL("../../../core/data-models/wrpc_call.cue", import.meta.url),
);
const iface = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const pin = {
	interfaceId: iface,
	stability: "stable" as const,
	versions: [parseWireVersion("0.2.0")],
};
const start = Date.parse("2030-01-01T00:00:00.000Z");
const deadline = "2030-01-01T00:00:01.000Z";

function object(value: JsonValue | undefined): JsonObject {
	if (!isJsonObject(value)) throw new TypeError("expected an object");
	return value;
}

function string(value: JsonValue | undefined): string {
	if (!isJsonString(value)) throw new TypeError("expected a string");
	return value;
}

function content(value: JsonValue | undefined): JsonValue {
	const contents = object(object(value).contents);
	if (
		contents.contentType !== "application/json" ||
		contents.content === undefined
	) {
		throw new TypeError("expected JSON pact content");
	}
	return contents.content;
}

function interactions() {
	const pact = object(parseJsonValue(readFileSync(pactPath, "utf8")));
	if (!Array.isArray(pact.interactions) || pact.interactions.length === 0) {
		throw new TypeError("expected pact interactions");
	}
	return pact.interactions.map((value) => {
		const interaction = object(value);
		if (
			interaction.type !== "Synchronous/Messages" ||
			!Array.isArray(interaction.response) ||
			interaction.response.length !== 1
		) {
			throw new TypeError("expected one synchronous pact response");
		}
		return {
			description: string(interaction.description),
			request: content(interaction.request),
			response: content(interaction.response[0]),
		};
	});
}

async function eventForScenario(value: JsonValue) {
	const scenario = string(object(value).scenario);
	if (!["success", "timeout", "provider-error"].includes(scenario)) {
		throw new TypeError("unknown call scenario");
	}
	const store = new ProviderHandlerStore();
	let clockReads = 0;
	const layer = createWrpcLinkLayer({
		store,
		transport: createInProcessTransport({ store }),
		compatibilityFloor: "0.2.0",
		clock: {
			nowMs: () =>
				scenario === "timeout" && clockReads++ > 0 ? start + 1_000 : start,
		},
	});
	layer.registerComponent({ id: "api", imports: [pin] });
	layer.registerProvider({
		id: "kv",
		exports: [pin],
		handlers: {
			[iface]: {
				get: () => {
					if (scenario === "timeout") return new Promise<JsonValue>(() => {});
					if (scenario === "provider-error")
						throw new Error("provider unavailable");
					return { value: "ok" };
				},
			},
		},
	});
	layer.establishLink({
		componentId: "api",
		providerId: "kv",
		importInterface: iface,
		exportInterface: iface,
	});
	try {
		await layer.callImport("api", iface, "get", {}, { deadline });
		if (scenario !== "success") throw new Error("expected call failure");
	} catch (error) {
		if (
			scenario === "success" ||
			(scenario === "timeout" && !(error instanceof DeadlineExceededError))
		)
			throw error;
	}
	const event = layer.events.at(-1);
	if (event?.type !== "link.Called") throw new Error("missing call event");
	return event;
}

function vetEvent(event: string) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-wrpc-call-"));
	try {
		const fixture = join(directory, "event.json");
		writeFileSync(fixture, event);
		const result = spawnSync(
			"cue",
			["vet", cueFile, fixture, "-d", "#WrpcCallEvent", "-c"],
			{ encoding: "utf8" },
		);
		if (result.error) throw result.error;
		return { status: result.status, stderr: result.stderr };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

it("round-trips real call events through protobuf and CUE", async () => {
	const contracts = interactions();
	expect(contracts).toHaveLength(3);
	for (const contract of contracts) {
		const event = await eventForScenario(contract.request);
		const wire = fromJson(WrpcCallEventSchema, contract.response);
		const restored = fromBinary(
			WrpcCallEventSchema,
			toBinary(WrpcCallEventSchema, wire),
		);
		expect(toJson(WrpcCallEventSchema, restored)).toEqual(event);
		const valid = vetEvent(JSON.stringify(event));
		expect(valid.status, valid.stderr).toBe(0);
	}
	const withoutDeadline = {
		...(await eventForScenario({ scenario: "success" })),
		deadline: null,
	};
	const noDeadlineWire = fromJson(
		WrpcCallEventSchema,
		parseJsonValue(JSON.stringify(withoutDeadline)),
	);
	expect(noDeadlineWire.deadline).toBeUndefined();
	expect(
		vetEvent(JSON.stringify(toJson(WrpcCallEventSchema, noDeadlineWire)))
			.status,
	).toBe(0);
	const event = await eventForScenario({ scenario: "timeout" });
	expect(
		vetEvent(JSON.stringify({ ...event, failureKind: "unknown" })).status,
	).not.toBe(0);
	expect(
		vetEvent(JSON.stringify({ ...event, failureKind: "retryable" })).status,
	).not.toBe(0);
});

it("verifies the call outcomes against the runtime provider", async () => {
	const contracts = interactions();
	const verified = new Set<string>();
	const invoke = async (message: MessageDescriptor) => {
		if (message.content === undefined || Buffer.isBuffer(message.content))
			throw new TypeError("expected a JSON pact request");
		verified.add(message.description);
		return cloneAsJson(
			await eventForScenario(parseJsonValue(JSON.stringify(message.content))),
		);
	};
	await new Verifier({
		provider: "RuntimeLocalWrpcCalls",
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
