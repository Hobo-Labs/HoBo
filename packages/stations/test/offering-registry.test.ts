// Phase-6 milestone: traffic-routing negotiation re-expressed through the
// generic resolver (its own tests unmodified elsewhere), and one data-store
// offering resolved against a station registration.
import assert from "node:assert/strict";
import {
	CLOUDFLARE_TRAFFIC_ROUTING_PROFILE,
	SIMPLE_TRAFFIC_ROUTING_PROFILE,
} from "@hobo/connectivity";
import { dataStoreOffering, parseDataStoreProviderProfile } from "@hobo/core";
import { test } from "vitest";

import { createStationOfferingRegistry } from "../src/offering-registry.js";

test("milestone: a data-store intent resolves against a station registration", () => {
	const registry = createStationOfferingRegistry({
		stationId: "station:prod",
		clock: () => "2026-08-03T00:00:00.000Z",
	});
	const registration = registry.register(
		"data-store",
		parseDataStoreProviderProfile({
			provider: "sqlite-local",
			offerings: [
				{ id: "sql.relational" },
				{ id: "sql.transactions" },
				{ id: "journal.event-stream" },
			],
			fallbacks: ["cdc.stream", "migrate.dual-write"],
		}),
	);
	assert.equal(registration.stationId, "station:prod");
	assert.equal(registration.registeredAt, "2026-08-03T00:00:00.000Z");

	const resolved = registry.resolve("data-store", {
		features: ["sql.relational", "migrate.dual-write"],
		negotiation: "prefer",
	});
	assert.equal(resolved.kind, "resolved");
	if (resolved.kind !== "resolved") return;
	assert.equal(resolved.provider, "sqlite-local");
	assert.deepEqual(resolved.strategy, ["sql.relational", "migrate.dual-write"]);
	assert.equal(resolved.match.kind, "partial");
});

test("traffic-routing profiles negotiate through the same registry unchanged", () => {
	const registry = createStationOfferingRegistry({ stationId: "station:prod" });
	registry.register("traffic-routing", CLOUDFLARE_TRAFFIC_ROUTING_PROFILE);
	registry.register("traffic-routing", SIMPLE_TRAFFIC_ROUTING_PROFILE);

	const resolved = registry.resolve("traffic-routing", {
		features: ["lb.weighted", "lb.health"],
		negotiation: "require",
	});
	assert.equal(resolved.kind, "resolved");
	if (resolved.kind !== "resolved") return;
	assert.equal(resolved.provider, "cloudflare");

	assert.deepEqual(registry.resourceClasses(), ["traffic-routing"]);
});

test("resolution fails closed with a remediation naming the resource class", () => {
	const registry = createStationOfferingRegistry({ stationId: "station:prod" });
	registry.register(
		"data-store",
		parseDataStoreProviderProfile({
			provider: "sqlite-local",
			offerings: [{ id: "sql.relational" }],
			fallbacks: [],
		}),
	);
	const resolved = registry.resolve("data-store", {
		features: ["replica.read"],
		negotiation: "require",
	});
	assert.equal(resolved.kind, "unresolved");
	if (resolved.kind !== "unresolved") return;
	assert.match(resolved.remediation, /data-store offerings: replica\.read/u);
});

test("re-registering a provider replaces its profile instead of duplicating it", () => {
	const registry = createStationOfferingRegistry({ stationId: "station:prod" });
	registry.register(
		"data-store",
		parseDataStoreProviderProfile({
			provider: "sqlite-local",
			offerings: [{ id: "sql.relational" }],
			fallbacks: [],
		}),
	);
	registry.register("data-store", {
		provider: "sqlite-local",
		offerings: [
			dataStoreOffering("sql.relational"),
			dataStoreOffering("kv.point"),
		],
		fallbacks: [],
	});
	assert.equal(registry.profiles("data-store").length, 1);
	const match = registry.match("data-store", "sqlite-local", {
		features: ["kv.point"],
		negotiation: "require",
	});
	assert.equal(match?.kind, "full");
});
