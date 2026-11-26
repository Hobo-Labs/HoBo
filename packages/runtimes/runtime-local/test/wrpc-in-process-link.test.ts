import {
	NoRouteError,
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createInProcessTransport,
	createJsonWitCodec,
	createWrpcLinkLayer,
} from "../src/index.js";

const KV = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const BLOB = parseInterfaceId("wasi:blobstore/blobstore@0.2.0");
const FLOOR = "0.2.0";

function createTestLayer() {
	const store = new ProviderHandlerStore();
	const transport = createInProcessTransport({
		store,
		codec: createJsonWitCodec(),
	});
	return createWrpcLinkLayer({ transport, compatibilityFloor: FLOOR, store });
}

function kvPin() {
	return {
		interfaceId: KV,
		stability: "stable" as const,
		versions: [parseWireVersion("0.2.0")],
	};
}

describe("wrpc in-process link layer", () => {
	it("linked WIT import routes to a provider export through the in-process wRPC membrane", async () => {
		const layer = createTestLayer();
		layer.registerComponent({ id: "api", imports: [kvPin()] });
		layer.registerProvider({
			id: "local-kv",
			exports: [kvPin()],
			handlers: {
				[KV]: {
					get: ({ key }: { key: string }) => ({ value: `stored:${key}` }),
				},
			},
		});

		const link = layer.establishLink({
			componentId: "api",
			importInterface: KV,
			providerId: "local-kv",
			exportInterface: KV,
		});
		const result = await layer.callImport(
			"api",
			KV,
			"get",
			{ key: "session" },
			{
				deadline: "2026-06-25T15:45:00.000Z",
			},
		);

		expect(link.boundaryMode).toBe("live");
		expect(link.transport).toBe("in-process");
		expect(result).toEqual({ value: "stored:session" });
		expect(layer.events.at(-1)).toEqual({
			type: "link.Called",
			componentId: "api",
			importInterface: KV,
			providerId: "local-kv",
			exportInterface: KV,
			operation: "get",
			boundaryMode: "live",
			transport: "in-process",
			deadline: "2026-06-25T15:45:00.000Z",
			codec: "json-wit",
		});
	});

	it("unlinked imports fail with typed no-route instead of panicking", async () => {
		const layer = createTestLayer();
		layer.registerComponent({ id: "worker", imports: [kvPin()] });
		layer.registerProvider({
			id: "local-kv",
			exports: [kvPin()],
			handlers: {
				[KV]: {
					get: () => ({ value: "should-not-route" }),
				},
			},
		});

		await expect(
			layer.callImport("worker", KV, "get", { key: "session" }),
		).rejects.toSatisfy(
			(error: Error) =>
				error instanceof NoRouteError && error.code === "no-route",
		);
		expect(layer.events.some((event) => event.type === "link.Called")).toBe(
			false,
		);
	});

	it("a provider export cannot be reached unless the exact import is in the link table", async () => {
		const layer = createTestLayer();
		const blobPin = {
			interfaceId: BLOB,
			stability: "stable" as const,
			versions: [parseWireVersion("0.2.0")],
		};
		layer.registerComponent({ id: "api", imports: [kvPin()] });
		layer.registerProvider({
			id: "storage-provider",
			exports: [kvPin(), blobPin],
			handlers: {
				[KV]: { get: () => ({ value: "kv" }) },
				[BLOB]: { read: () => ({ bytes: [1, 2, 3] }) },
			},
		});
		layer.establishLink({
			componentId: "api",
			importInterface: KV,
			providerId: "storage-provider",
			exportInterface: KV,
		});

		await expect(
			layer.callImport("api", BLOB, "read", { key: "secret" }),
		).rejects.toSatisfy(
			(error: Error) =>
				error instanceof NoRouteError && error.routeKey === `api\0${BLOB}`,
		);
	});
});
