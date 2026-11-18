import { expect, it } from "vitest";
import {
	collectBindleManifest,
	evaluateBindingDeliveryGate,
} from "../src/index.js";

it("allows collected binding references while rejecting environment delivery", () => {
	const { manifest } = collectBindleManifest({
		bindleId: "fixture",
		componentHost: { kind: "wasmtime", version: "1" },
		define(collector) {
			const db = collector.data("db", { paradigm: "kv" });
			collector.service("api", { bind: { db } });
		},
	});
	expect(manifest.value.resources.db?.connectionString).toBe(
		"{db.connectionString}",
	);
	expect(evaluateBindingDeliveryGate({ manifest }).ok).toBe(true);
	expect(
		evaluateBindingDeliveryGate({ env: { DB: "{db.connectionString}" } }).ok,
	).toBe(false);
});
