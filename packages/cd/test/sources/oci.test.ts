import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	SelectionStrategy,
	SubscriptionKind,
	SubscriptionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { createOciDriver, parseChallenge, parseOciLocator } from "../../src/sources/drivers/oci.js";
import {
	COMMIT_A,
	COMMIT_B,
	DIGESTS,
	OCI_BASE,
	OCI_FIXTURES,
	statementFor,
	TOKEN_URL,
} from "./oci-fixtures.js";
import {
	clock,
	context,
	FixtureTransport,
	signal,
	StaticCredentials,
	type SubscriptionInit,
} from "./support.js";

function sub(extra: SubscriptionInit = {}) {
	return create(SubscriptionRecordSchema, {
		name: "image",
		kind: SubscriptionKind.OCI_REPOSITORY,
		locator: "registry.example.com/team/app",
		selection: SelectionStrategy.SEMVER,
		...extra,
	});
}

describe("OCI driver", () => {
	it("lists tags across pages through the bearer-token flow and resolves digests by HEAD", async () => {
		const fixture = new FixtureTransport(OCI_FIXTURES);
		const driver = createOciDriver({ http: fixture.http });
		const outcome = await driver.discover({ source: "app", subscription: sub(), signal }, context(clock().now));
		if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
		expect(fixture.unmatched).toEqual([]);
		expect(outcome.value.artifacts.map((item) => [item.version, item.artifact?.digest, item.commit])).toEqual([
			["1.0.0", DIGESTS["1.0.0"], COMMIT_A],
			["1.1.0", DIGESTS["1.1.0"], COMMIT_A],
			["1.2.0", DIGESTS["1.2.0"], COMMIT_B],
		]);
		expect(outcome.value.artifacts[2]?.artifact?.coordinate).toBe(`registry.example.com/team/app@${DIGESTS["1.2.0"]}`);
		expect(fixture.requests.filter((item) => item.method === "HEAD").length).toBe(3);
		expect(fixture.requests.filter((item) => item.url === TOKEN_URL).length).toBe(1);
	});

	it("never discovers an older tag after a newer one", async () => {
		const ctx = context(clock().now);
		const driver = createOciDriver({ http: new FixtureTransport(OCI_FIXTURES).http });
		const cursor = JSON.stringify({ hw: "1.1.0" });
		const outcome = await driver.discover({ source: "app", subscription: sub(), cursor, signal }, ctx);
		expect(outcome.ok && outcome.value.artifacts.map((item) => item.version)).toEqual(["1.2.0"]);
	});

	it("selects NEWEST_BUILD by the created annotation", async () => {
		const outcome = await createOciDriver({ http: new FixtureTransport(OCI_FIXTURES).http }).discover(
			{ source: "app", subscription: sub({ selection: SelectionStrategy.NEWEST_BUILD, allowPattern: "^\\d", discoveryLimit: 1 }), signal },
			context(clock().now),
		);
		expect(outcome.ok && outcome.value.artifacts.map((item) => item.version)).toEqual(["1.2.0"]);
	});

	it("fetches Sigstore-bundle attestations through the referrers API, with the tag-schema fallback", async () => {
		const driver = createOciDriver({ http: new FixtureTransport(OCI_FIXTURES).http });
		const ctx = context(clock().now);
		const discovered = await driver.discover({ source: "app", subscription: sub(), signal }, ctx);
		if (!discovered.ok) throw new Error("discover");
		const [one, two, three] = discovered.value.artifacts;
		if (!one || !two || !three) throw new Error("artifacts");
		const signed = await driver.attestations({ subscription: sub(), artifact: three, signal }, ctx);
		if (!signed.ok) throw new Error(JSON.stringify(signed.reasons));
		expect(signed.value).toHaveLength(1);
		expect(new TextDecoder().decode(signed.value[0]?.statement)).toBe(statementFor(DIGESTS["1.2.0"]));
		expect(signed.value[0]?.bundle).toBeDefined();
		const fallback = await driver.attestations({ subscription: sub(), artifact: two, signal }, ctx);
		expect(fallback.ok && fallback.value).toEqual([]);
		const none = await driver.attestations({ subscription: sub(), artifact: one, signal }, ctx);
		expect(none.ok && none.value).toEqual([]);
	});

	it("sends the subscription credential only to the token realm", async () => {
		const credentials = new StaticCredentials({ "reg-ro": { username: "bot", password: "pw" } });
		const fixture = new FixtureTransport(OCI_FIXTURES);
		const driver = createOciDriver({ http: fixture.http, credentials });
		const outcome = await driver.discover({ source: "app", subscription: sub({ credentialRef: "reg-ro" }), signal }, context(clock().now));
		expect(outcome.ok).toBe(true);
		const basic = `Basic ${Buffer.from("bot:pw").toString("base64")}`;
		const withBasic = fixture.requests.filter((item) => item.headers.authorization === basic).map((item) => item.url);
		expect(withBasic).toEqual([TOKEN_URL]);
	});

	it("backs off on a 429 from the registry", async () => {
		const fixture = new FixtureTransport([{ url: `${OCI_BASE}/tags/list?n=1000`, status: 429, responseHeaders: { "retry-after": "30" } }]);
		const outcome = await createOciDriver({ http: fixture.http }).discover({ source: "app", subscription: sub(), signal }, context(clock().now));
		expect(!outcome.ok && [outcome.reasons[0]?.code, outcome.reasons[0]?.subject]).toEqual(["source-rate-limited", "retry-after-ms:30000"]);
	});

	it("parses locators and challenges", () => {
		expect(parseOciLocator("docker.io/nginx")).toMatchObject({ ok: true, value: { host: "registry-1.docker.io", repository: "library/nginx" } });
		expect(parseOciLocator("https://registry.example.com/x").ok).toBe(false);
		expect(parseOciLocator("registry.example.com/Team/App").ok).toBe(false);
		expect(parseChallenge('Bearer realm="https://a/token",service="s",scope="repository:x:pull"')).toEqual({
			scheme: "bearer",
			realm: "https://a/token",
			service: "s",
			scope: "repository:x:pull",
		});
	});
});
