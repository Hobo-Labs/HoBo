import {
	NoRouteError,
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
	WireVersionIncompatibleError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createInProcessTransport, createWrpcLinkLayer } from "../src/index.js";

const KV = parseInterfaceId("wasi:keyvalue/store@1.2.0");
const FLOOR = "1.3.0";

function createTestLayer(floor = FLOOR) {
	const store = new ProviderHandlerStore();
	const transport = createInProcessTransport({ store });
	return createWrpcLinkLayer({ transport, compatibilityFloor: floor, store });
}

describe("wrpc wire-version negotiation", () => {
	it("caller@N and provider@N+1 negotiate the highest shared minor before establishing the link", () => {
		const layer = createTestLayer("1.2.0");
		layer.registerComponent({
			id: "api",
			imports: [
				{
					interfaceId: KV,
					stability: "stable",
					versions: [parseWireVersion("1.2.0")],
				},
			],
		});
		layer.registerProvider({
			id: "local-kv",
			exports: [
				{
					interfaceId: KV,
					stability: "stable",
					versions: [parseWireVersion("1.2.0"), parseWireVersion("1.3.0")],
				},
			],
			handlers: { [KV]: { get: () => ({ value: "ok" }) } },
		});

		const link = layer.establishLink({
			componentId: "api",
			importInterface: KV,
			providerId: "local-kv",
			exportInterface: KV,
		});

		expect(link.negotiatedWire.minor).toBe("1.2");
		expect(layer.events.at(-1)?.type).toBe("link.Established");
	});

	it("a shared minor below the declared floor rejects the link with version-incompatible", async () => {
		let providerCalls = 0;
		const layer = createTestLayer(FLOOR);
		layer.registerComponent({
			id: "api",
			imports: [
				{
					interfaceId: KV,
					stability: "stable",
					versions: [parseWireVersion("1.2.0")],
				},
			],
		});
		layer.registerProvider({
			id: "local-kv",
			exports: [
				{
					interfaceId: KV,
					stability: "stable",
					versions: [parseWireVersion("1.2.5")],
				},
			],
			handlers: {
				[KV]: {
					get() {
						providerCalls += 1;
						return { value: "should-not-run" };
					},
				},
			},
		});

		expect(() =>
			layer.establishLink({
				componentId: "api",
				importInterface: KV,
				providerId: "local-kv",
				exportInterface: KV,
			}),
		).toThrow(WireVersionIncompatibleError);
		expect(layer.events.some((event) => event.type === "link.Rejected")).toBe(
			true,
		);
		expect(providerCalls).toBe(0);

		await expect(
			layer.callImport("api", KV, "get", { key: "session" }),
		).rejects.toBeInstanceOf(NoRouteError);
	});

	it("no shared minor at all rejects with version-incompatible no-shared-minor", () => {
		const layer = createTestLayer("1.2.0");
		layer.registerComponent({
			id: "api",
			imports: [
				{
					interfaceId: KV,
					stability: "stable",
					versions: [parseWireVersion("1.2.0")],
				},
			],
		});
		layer.registerProvider({
			id: "local-kv",
			exports: [
				{
					interfaceId: KV,
					stability: "stable",
					versions: [parseWireVersion("2.0.0")],
				},
			],
			handlers: { [KV]: { get: () => ({ value: "nope" }) } },
		});

		expect(() =>
			layer.establishLink({
				componentId: "api",
				importInterface: KV,
				providerId: "local-kv",
				exportInterface: KV,
			}),
		).toThrow(WireVersionIncompatibleError);
	});
});
