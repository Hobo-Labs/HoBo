import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	SelectionStrategy,
	SubscriptionKind,
	SubscriptionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { createHttpIndexDriver } from "../../src/sources/drivers/http-index.js";
import {
	clock,
	context,
	digestOf,
	FixtureTransport,
	json,
	signal,
	type SubscriptionInit,
} from "./support.js";

const INDEX = "https://downloads.example.com/web/index.json";

function subscription(overrides: SubscriptionInit = {}) {
	return create(SubscriptionRecordSchema, {
		name: "bundle",
		kind: SubscriptionKind.HTTP_INDEX,
		locator: INDEX,
		selection: SelectionStrategy.SEMVER,
		artifactKind: ArtifactKind.STATIC_ASSETS,
		...overrides,
	});
}

const entries = [
	{ version: "1.0.0", url: "https://downloads.example.com/web/1.0.0.tgz", digest: digestOf("1.0.0") },
	{ version: "1.2.0", url: "https://downloads.example.com/web/1.2.0.tgz", digest: digestOf("1.2.0"), commit: "a".repeat(40) },
	{ version: "1.1.0", url: "https://downloads.example.com/web/1.1.0.tgz", digest: digestOf("1.1.0") },
	{ version: "nightly", url: "https://downloads.example.com/web/nightly.tgz", digest: digestOf("n") },
	{ version: "1.3.0", url: "https://downloads.example.com/web/1.3.0.tgz", digest: "md5:abc" },
];

describe("HTTP index driver", () => {
	it("discovers SemVer entries from a recorded index, oldest first, skipping malformed digests", async () => {
		const fixture = new FixtureTransport([{ url: INDEX, headers: { accept: "application/json" }, response: json(entries) }]);
		const driver = createHttpIndexDriver({ http: fixture.http });
		const ctx = context(clock().now);
		const outcome = await driver.discover({ source: "web", subscription: subscription(), signal }, ctx);
		if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
		expect(outcome.value.artifacts.map((item) => item.version)).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
		const newest = outcome.value.artifacts.at(-1);
		expect(newest?.artifact?.digest).toBe(digestOf("1.2.0"));
		expect(newest?.artifact?.coordinate).toBe("https://downloads.example.com/web/1.2.0.tgz");
		expect(newest?.artifact?.ecosystem).toBe("http");
		expect(newest?.commit).toBe("a".repeat(40));
	});

	it("never discovers an older version after a newer one (forward-only high-water mark)", async () => {
		const ctx = context(clock().now);
		const first = new FixtureTransport([{ url: INDEX, response: json(entries.slice(0, 2)) }]);
		const one = await createHttpIndexDriver({ http: first.http }).discover({ source: "web", subscription: subscription(), signal }, ctx);
		if (!one.ok) throw new Error("first poll");
		const later = new FixtureTransport([{ url: INDEX, response: json(entries) }]);
		const two = await createHttpIndexDriver({ http: later.http }).discover(
			{ source: "web", subscription: subscription(), cursor: one.value.cursor, signal },
			ctx,
		);
		if (!two.ok) throw new Error("second poll");
		expect(two.value.artifacts).toEqual([]);
	});

	it("honours the discovery limit by keeping the newest", async () => {
		const fixture = new FixtureTransport([{ url: INDEX, response: json({ items: entries }) }]);
		const outcome = await createHttpIndexDriver({ http: fixture.http }).discover(
			{ source: "web", subscription: subscription({ discoveryLimit: 1 }), signal },
			context(clock().now),
		);
		expect(outcome.ok && outcome.value.artifacts.map((item) => item.version)).toEqual(["1.2.0"]);
	});

	it("backs off on a rate-limit response", async () => {
		const fixture = new FixtureTransport([{ url: INDEX, status: 429, responseHeaders: { "Retry-After": "120" } }]);
		const outcome = await createHttpIndexDriver({ http: fixture.http }).discover(
			{ source: "web", subscription: subscription(), signal },
			context(clock().now),
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.reasons[0]?.code).toBe("source-rate-limited");
			expect(outcome.reasons[0]?.subject).toBe("retry-after-ms:120000");
		}
	});

	it("refuses an index entry URL that is not https or carries credentials", async () => {
		const bad = [
			{ version: "2.0.0", url: "http://downloads.example.com/2.tgz", digest: digestOf("2") },
			{ version: "2.1.0", url: "https://user:pw@downloads.example.com/2.1.tgz", digest: digestOf("21") },
		];
		const fixture = new FixtureTransport([{ url: INDEX, response: json(bad) }]);
		const outcome = await createHttpIndexDriver({ http: fixture.http }).discover(
			{ source: "web", subscription: subscription(), signal },
			context(clock().now),
		);
		expect(outcome.ok && outcome.value.artifacts).toEqual([]);
	});
});
