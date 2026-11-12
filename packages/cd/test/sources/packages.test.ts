import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	SelectionStrategy,
	SubscriptionKind,
	SubscriptionRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { createPackageRegistryDriver } from "../../src/sources/drivers/packages.js";
import { integrity, PACKAGE_FIXTURES, tarball, tarballBody } from "./package-fixtures.js";
import {
	clock,
	context,
	digestOf,
	dump,
	type Exchange,
	FixtureTransport,
	json,
	signal,
	StaticCredentials,
	type SubscriptionInit,
} from "./support.js";

function sub(ecosystem: string, locator: string, extra: SubscriptionInit = {}) {
	return create(SubscriptionRecordSchema, {
		name: `${ecosystem}-pkg`,
		kind: SubscriptionKind.PACKAGE_REGISTRY,
		ecosystem,
		locator,
		selection: SelectionStrategy.SEMVER,
		artifactKind: ArtifactKind.PACKAGE,
		...extra,
	});
}

async function discover(subscription: ReturnType<typeof sub>, exchanges: readonly Exchange[] = PACKAGE_FIXTURES) {
	const fixture = new FixtureTransport(exchanges);
	const driver = createPackageRegistryDriver({ http: fixture.http });
	const outcome = await driver.discover({ source: "pkgs", subscription, signal }, context(clock().now));
	if (!outcome.ok) throw new Error(JSON.stringify(outcome.reasons));
	return { artifacts: outcome.value.artifacts, fixture };
}

describe("package registry driver", () => {
	it("npm: hashes the tarball (sha256) after checking its sha512 integrity, and excludes prereleases", async () => {
		const { artifacts } = await discover(sub("npm", "@acme/web"));
		expect(artifacts.map((item) => item.version)).toEqual(["1.0.0"]);
		expect(artifacts[0]?.artifact?.digest).toBe(digestOf(tarball));
		expect(artifacts[0]?.artifact?.coordinate).toBe("pkg:npm/%40acme/web@1.0.0");
		expect(artifacts[0]?.artifact?.ecosystem).toBe("npm");
	});

	it("npm: an integrity mismatch is an upstream error, never a digest", async () => {
		const tampered = PACKAGE_FIXTURES.map((item) =>
			item.url.endsWith("web-1.0.0.tgz") ? { ...item, response: `${tarballBody}x` } : item,
		);
		const fixture = new FixtureTransport(tampered);
		const outcome = await createPackageRegistryDriver({ http: fixture.http }).discover(
			{ source: "pkgs", subscription: sub("npm", "@acme/web"), signal },
			context(clock().now),
		);
		expect(!outcome.ok && outcome.reasons[0]?.code).toBe("source-upstream-invalid");
	});

	it("PyPI: prefers the sdist sha256 and skips yanked releases", async () => {
		const { artifacts } = await discover(sub("pypi", "acme-web"));
		expect(artifacts.map((item) => [item.version, item.artifact?.digest])).toEqual([["2.0.0", `sha256:${"2".repeat(64)}`]]);
		expect(artifacts[0]?.artifact?.coordinate).toBe("pkg:pypi/acme-web@2.0.0");
	});

	it("crates (sparse index): uses cksum and skips yanked versions", async () => {
		const { artifacts } = await discover(sub("cargo", "acme-web"));
		expect(artifacts.map((item) => [item.version, item.artifact?.digest])).toEqual([["0.1.0", `sha256:${"4".repeat(64)}`]]);
	});

	it("RubyGems: uses the ruby-platform gem sha", async () => {
		const { artifacts } = await discover(sub("rubygems", "acme-web"));
		expect(artifacts.map((item) => item.artifact?.digest)).toEqual([`sha256:${"6".repeat(64)}`]);
	});

	it("NuGet: hashes the nupkg from the flat container", async () => {
		const { artifacts } = await discover(sub("nuget", "Acme.Web"));
		expect(artifacts.map((item) => [item.version, item.artifact?.digest])).toEqual([["4.0.0", digestOf(tarball)]]);
	});

	it("Maven: reads maven-metadata.xml, uses the .sha256 sidecar, else hashes the jar", async () => {
		const { artifacts } = await discover(sub("maven", "com.acme:web"));
		expect(artifacts.map((item) => [item.version, item.artifact?.digest])).toEqual([
			["5.0.0", `sha256:${"8".repeat(64)}`],
			["5.1.0", digestOf(tarball)],
		]);
		expect(artifacts[0]?.artifact?.coordinate).toBe("pkg:maven/com.acme/web@5.0.0");
	});

	it("reads a private registry with the subscription credential and an explicit base URL", async () => {
		const exchanges: Exchange[] = [
			{
				url: "https://npm.internal.example/web",
				headers: { authorization: "Bearer s3cret" },
				response: json({ versions: { "1.0.0": { dist: { tarball: "https://npm.internal.example/web-1.0.0.tgz", integrity } } } }),
			},
			{ url: "https://npm.internal.example/web-1.0.0.tgz", headers: { authorization: "Bearer s3cret" }, response: tarballBody },
		];
		const fixture = new FixtureTransport(exchanges);
		const driver = createPackageRegistryDriver({ http: fixture.http, credentials: new StaticCredentials({ "npm-ro": { token: "s3cret" } }) });
		const outcome = await driver.discover(
			{ source: "pkgs", subscription: sub("npm", "https://npm.internal.example|web", { credentialRef: "npm-ro" }), signal },
			context(clock().now),
		);
		expect(outcome.ok && outcome.value.artifacts.length).toBe(1);
		expect(dump(outcome)).not.toContain("s3cret");
	});

	it("refuses an unknown ecosystem", async () => {
		const outcome = await createPackageRegistryDriver({ http: new FixtureTransport([]).http }).discover(
			{ source: "pkgs", subscription: sub("hex", "x"), signal },
			context(clock().now),
		);
		expect(!outcome.ok && outcome.reasons[0]?.code).toBe("source-invalid");
	});
});
