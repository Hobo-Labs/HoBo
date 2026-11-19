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
	it("records current negotiated links in an independent manifest snapshot", () => {
		const layer = createTestLayer("1.2.0");
		const empty = layer.manifestIr();
		layer.registerComponent({
			id: "api",
			imports: [
				{
					interfaceId: KV,
					stability: "stable",
					versions: [parseWireVersion("1.2.0"), parseWireVersion("1.3.0")],
				},
			],
		});
		layer.registerProvider({
			id: "local-kv",
			exports: [
				{
					interfaceId: KV,
					stability: "stable",
					versions: [parseWireVersion("1.2.1"), parseWireVersion("1.3.2")],
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
		const snapshot = layer.manifestIr();
		expect(empty).toEqual({ schema: "hobo.manifest.wrpc-links/v1", links: [] });
		expect(snapshot).toEqual({
			schema: "hobo.manifest.wrpc-links/v1",
			links: [
				{
					componentId: "api",
					importInterface: KV,
					providerId: "local-kv",
					exportInterface: KV,
					wire: {
						interfaceId: KV,
						version: "1.3.0",
						minor: "1.3",
						stability: "stable",
						floor: "1.2.0",
					},
				},
			],
		});
		expect(snapshot.links[0]?.wire).toEqual(link.negotiatedWire);
		expect(snapshot.links[0]?.wire).not.toBe(link.negotiatedWire);

		layer.registerProvider({
			id: "backup-kv",
			exports: [
				{
					interfaceId: KV,
					stability: "stable",
					versions: [parseWireVersion("1.2.1")],
				},
			],
			handlers: { [KV]: { get: () => ({ value: "backup" }) } },
		});
		layer.establishLink({
			componentId: "api",
			importInterface: KV,
			providerId: "backup-kv",
			exportInterface: KV,
		});
		expect(snapshot.links[0]?.providerId).toBe("local-kv");
		expect(layer.manifestIr().links).toMatchObject([
			{ providerId: "backup-kv", wire: { minor: "1.2" } },
		]);
	});

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
		expect(layer.manifestIr().links).toEqual([]);
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
