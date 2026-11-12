// PACT verification for every WP2 boundary (plan 0024 §9 WP2 "PACT per
// driver"). Outbound drivers are consumers: every request they make must match
// a contracted interaction exactly, every interaction must be exercised, and
// they must accept the contracted responses. The webhook receiver is a
// provider: every contracted sender request must get the contracted response.
import { create } from "@bufbuild/protobuf";
import type { HttpTransport, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	FreightSourceRecordSchema,
	SubscriptionKind as Kind,
	SelectionStrategy,
	type SubscriptionKind,
	SubscriptionRecordSchema,
} from "../src/_generated/cd_pb.js";
import type { CiEventReader, Digest, RailEventReader } from "../src/ports.js";
import {
	createCiDriver,
	createFreightSources,
	createGitDriver,
	createHttpIndexDriver,
	createOciDriver,
	createPackageRegistryDriver,
	createRailDriver,
	createSubscriptionDrivers,
	WEBHOOK_RECEIVERS,
	webhookSecretRef,
} from "../src/sources/index.js";
import { encode, isRecord, isText, sha256Digest } from "../src/sources/json.js";
import {
	asLedger,
	clock,
	context,
	FakeAuthorizer,
	FakeLedger,
	FakeProvenance,
	MemoryEventStore,
	StaticCredentials,
	type SubscriptionInit,
	signal,
	TENANT,
} from "../test/sources/support.js";
import gitPact from "./sources.git.pact.json" with { type: "json" };
import ciPact from "./sources.hobo-ci.pact.json" with { type: "json" };
import railPact from "./sources.hobo-rail.pact.json" with { type: "json" };
import indexPact from "./sources.http-index.pact.json" with { type: "json" };
import ociPact from "./sources.oci.pact.json" with { type: "json" };
import packagesPact from "./sources.packages.pact.json" with { type: "json" };
import webhooksPact from "./sources.webhooks.pact.json" with { type: "json" };

type PactBody = Readonly<{
	content: string;
	contentType: string;
	encoded: string | boolean;
}>;
type HttpInteraction = Readonly<{
	description: string;
	providerStates: readonly Readonly<{ name: string }>[];
	request: Readonly<{
		method: string;
		path: string;
		query?: string;
		headers: Readonly<Record<string, string>>;
		body?: PactBody;
	}>;
	response: Readonly<{
		status: number;
		headers: Readonly<Record<string, string>>;
		body?: PactBody;
	}>;
}>;

function decodeBody(body: PactBody | undefined): string {
	if (!body) return "";
	return body.encoded === "base64"
		? Buffer.from(body.content, "base64").toString("latin1")
		: body.content;
}

function urlOf(item: HttpInteraction): string {
	const origin =
		item.providerStates
			.find((state) => state.name.startsWith("origin "))
			?.name.slice(7) ?? "";
	return `${origin}${item.request.path}${item.request.query ? `?${item.request.query}` : ""}`;
}

/** A transport that serves only contracted interactions and records coverage. */
function contracted(
	interactions: readonly HttpInteraction[],
	states: readonly string[] = [],
) {
	const seen = new Set<string>();
	const unmatched: TransportRequest[] = [];
	const http: HttpTransport = async (request) => {
		const found = interactions.find(
			(item) =>
				states.every(
					(state) =>
						item.providerStates.some((candidate) => candidate.name === state) ||
						!item.providerStates.some((candidate) =>
							candidate.name.startsWith(state.split(" ")[0] ?? ""),
						),
				) &&
				urlOf(item) === request.url &&
				item.request.method === request.method &&
				Object.entries(item.request.headers).every(
					([key, value]) => request.headers[key] === value,
				) &&
				(item.request.body === undefined ||
					decodeBody(item.request.body) === request.body),
		);
		if (!found) {
			unmatched.push(request);
			return { status: 599, headers: {}, body: "" };
		}
		seen.add(found.description);
		return {
			status: found.response.status,
			headers: found.response.headers,
			body: decodeBody(found.response.body),
		};
	};
	return { http, seen, unmatched };
}

function sub(init: SubscriptionInit) {
	return create(SubscriptionRecordSchema, init);
}

describe("OCI distribution contract (sources.oci.pact.json)", () => {
	it("issues only contracted requests, exercises every interaction, and accepts the responses", async () => {
		const pact = contracted(ociPact.interactions);
		const driver = createOciDriver({ http: pact.http });
		const ctx = context(clock().now);
		const locator = "registry.example.com/team/app";
		const semver = await driver.discover(
			{
				source: "app",
				subscription: sub({
					name: "image",
					kind: Kind.OCI_REPOSITORY,
					locator,
					selection: SelectionStrategy.SEMVER,
				}),
				signal,
			},
			ctx,
		);
		if (!semver.ok) throw new Error(JSON.stringify(semver.reasons));
		expect(semver.value.artifacts).toHaveLength(3);
		const newest = await driver.discover(
			{
				source: "app",
				subscription: sub({
					name: "image",
					kind: Kind.OCI_REPOSITORY,
					locator,
					selection: SelectionStrategy.NEWEST_BUILD,
					allowPattern: "^\\d",
				}),
				signal,
			},
			ctx,
		);
		expect(newest.ok).toBe(true);
		for (const artifact of semver.value.artifacts) {
			const attestations = await driver.attestations(
				{
					subscription: sub({
						name: "image",
						kind: Kind.OCI_REPOSITORY,
						locator,
					}),
					artifact,
					signal,
				},
				ctx,
			);
			expect(attestations.ok).toBe(true);
		}
		expect(pact.unmatched).toEqual([]);
		expect([...pact.seen].sort()).toEqual(
			ociPact.interactions.map((item) => item.description).sort(),
		);
	});
});

describe("Git smart-HTTP v2 contract (sources.git.pact.json)", () => {
	it("speaks protocol v2 exactly as recorded from git upload-pack", async () => {
		const base = "https://git.example.com/acme/web.git";
		const seen = new Set<string>();
		for (const set of ["t1", "t2", "t3"] as const) {
			const pact = contracted(
				gitPact.interactions.filter((item) =>
					item.providerStates.some(
						(state) => state.name === `repository at ${set}`,
					),
				),
			);
			const driver = createGitDriver({ http: pact.http });
			const ctx = context(clock().now);
			const runs: SubscriptionInit[] = [
				{
					name: "decl",
					kind: Kind.GIT_REPOSITORY,
					locator: base,
					branch: "main",
				},
				{
					name: "decl",
					kind: Kind.GIT_REPOSITORY,
					locator: base,
					branch: "main",
					includePaths: ["deploy"],
				},
				{
					name: "decl",
					kind: Kind.GIT_REPOSITORY,
					locator: base,
					selection: SelectionStrategy.SEMVER,
					semverRange:
						set === "t1" ? "1.0.0" : set === "t2" ? ">=1.1.0" : ">=1.0.0",
				},
			];
			if (set === "t3")
				runs.push({
					name: "decl",
					kind: Kind.GIT_REPOSITORY,
					locator: base,
					selection: SelectionStrategy.SEMVER,
					includePaths: ["deploy"],
				});
			for (const init of runs) {
				const outcome = await driver.discover(
					{ source: "web", subscription: sub(init), signal },
					ctx,
				);
				if (!outcome.ok)
					throw new Error(`${set}: ${JSON.stringify(outcome.reasons)}`);
				expect(outcome.value.artifacts.length).toBeGreaterThan(0);
			}
			expect(pact.unmatched.map((item) => item.body)).toEqual([]);
			for (const description of pact.seen) seen.add(description);
		}
		expect([...seen].sort()).toEqual(
			gitPact.interactions.map((item) => item.description).sort(),
		);
	});
});

describe("package registry contract (sources.packages.pact.json)", () => {
	it("reads every ecosystem's metadata and package bytes as contracted", async () => {
		const pact = contracted(packagesPact.interactions);
		const driver = createPackageRegistryDriver({ http: pact.http });
		const ctx = context(clock().now);
		const cases = [
			["npm", "@acme/web"],
			["pypi", "acme-web"],
			["cargo", "acme-web"],
			["rubygems", "acme-web"],
			["nuget", "Acme.Web"],
			["maven", "com.acme:web"],
		] as const;
		for (const [ecosystem, locator] of cases) {
			const outcome = await driver.discover(
				{
					source: "pkgs",
					subscription: sub({
						name: "pkg",
						kind: Kind.PACKAGE_REGISTRY,
						ecosystem,
						locator,
						selection: SelectionStrategy.SEMVER,
					}),
					signal,
				},
				ctx,
			);
			if (!outcome.ok)
				throw new Error(`${ecosystem}: ${JSON.stringify(outcome.reasons)}`);
			expect(outcome.value.artifacts.length, ecosystem).toBeGreaterThan(0);
		}
		expect(pact.unmatched).toEqual([]);
		expect([...pact.seen].sort()).toEqual(
			packagesPact.interactions.map((item) => item.description).sort(),
		);
	});
});

describe("HTTP index contract (sources.http-index.pact.json)", () => {
	it("accepts the list and {items} forms", async () => {
		const pact = contracted(indexPact.interactions);
		const driver = createHttpIndexDriver({ http: pact.http });
		const ctx = context(clock().now);
		for (const path of ["/web/index.json", "/web/items.json"]) {
			const outcome = await driver.discover(
				{
					source: "assets",
					subscription: sub({
						name: "assets",
						kind: Kind.HTTP_INDEX,
						locator: `https://downloads.example.com${path}`,
						artifactKind: ArtifactKind.STATIC_ASSETS,
					}),
					signal,
				},
				ctx,
			);
			expect(
				outcome.ok && outcome.value.artifacts.map((item) => item.version),
			).toEqual(["1.0.0", "1.1.0"]);
		}
		expect([...pact.seen].sort()).toEqual(
			indexPact.interactions.map((item) => item.description).sort(),
		);
	});
});

describe("HoBo CI event contract (sources.hobo-ci.pact.json)", () => {
	it("discovers the passing run's output only, verified by the read-back bytes", async () => {
		const reader: CiEventReader = async function* () {
			for (const item of ciPact.interactions) yield item.contents;
		};
		const driver = createCiDriver({
			readCiEvents: reader,
			readCiArtifact: async (runId) =>
				runId === "run-42" ? encode("contract-wasm") : undefined,
		});
		const outcome = await driver.discover(
			{
				source: "ci",
				subscription: sub({
					name: "wasm",
					kind: Kind.HOBO_CI,
					locator: "web-build",
					artifactName: "dist/web.wasm",
					artifactKind: ArtifactKind.WASM_COMPONENT,
					selection: SelectionStrategy.NEWEST_BUILD,
				}),
				signal,
			},
			context(clock().now),
		);
		expect(
			outcome.ok &&
				outcome.value.artifacts.map((item) => [
					item.version,
					item.artifact?.digest,
					item.commit,
				]),
		).toEqual([
			["run-42", sha256Digest(encode("contract-wasm")), "d".repeat(40)],
		]);
	});
});

describe("Rail journal contract (sources.hobo-rail.pact.json)", () => {
	it("discovers approved digests once and never a retired one", async () => {
		const reader: RailEventReader = async function* () {
			for (const item of railPact.interactions) {
				const { railDigest, status, ...rest } = item.contents;
				if (
					!/^sha256:/.test(railDigest) ||
					(status !== "approved" && status !== "active" && status !== "retired")
				)
					throw new Error("contract");
				// SAFETY: checked against the sha256 prefix just above.
				yield { ...rest, railDigest: railDigest as Digest, status };
			}
		};
		const outcome = await createRailDriver({ readRailEvents: reader }).discover(
			{
				source: "rail-prod",
				subscription: sub({
					name: "rail",
					kind: Kind.HOBO_RAIL,
					locator: "rail-prod",
				}),
				signal,
			},
			context(clock().now),
		);
		expect(
			outcome.ok && outcome.value.artifacts.map((item) => item.version),
		).toEqual([`sha256:${"e".repeat(64)}`]);
	});
});

describe("webhook receiver contract (sources.webhooks.pact.json, provider verification)", () => {
	it("answers every contracted sender request as contracted and records no Freight", async () => {
		const time = clock();
		const ledger = new FakeLedger();
		const secrets = new StaticCredentials(
			Object.fromEntries(
				WEBHOOK_RECEIVERS.map((receiver) => [
					webhookSecretRef(receiver),
					{ secret: "contract-secret", token: "contract-token" },
				]),
			),
		);
		const sources = createFreightSources({
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: time.now,
			ledger: asLedger(ledger),
			drivers: createSubscriptionDrivers({
				http: async () => ({ status: 599, headers: {}, body: "" }),
				credentials: new StaticCredentials({}),
			}),
			provenance: new FakeProvenance(),
			authorizer: new FakeAuthorizer(),
			webhookSecrets: secrets,
		});
		const ctx = context(time.now);
		const defined: ReadonlyArray<readonly [string, SubscriptionKind, string]> =
			[
				["git-web", Kind.GIT_REPOSITORY, "https://github.com/acme/web.git"],
				["gitlab-web", Kind.GIT_REPOSITORY, "https://gitlab.com/acme/web.git"],
				[
					"bitbucket-web",
					Kind.GIT_REPOSITORY,
					"https://bitbucket.org/acme/web.git",
				],
				["gitea-web", Kind.GIT_REPOSITORY, "https://codeberg.org/acme/web.git"],
				["ghcr-app", Kind.OCI_REPOSITORY, "ghcr.io/acme/app"],
				["harbor-app", Kind.OCI_REPOSITORY, "harbor.example.com/acme/app"],
				["dockerhub-app", Kind.OCI_REPOSITORY, "docker.io/acme/app"],
				[
					"ecr-app",
					Kind.OCI_REPOSITORY,
					"123456789012.dkr.ecr.eu-west-1.amazonaws.com/acme/app",
				],
				["gar-app", Kind.OCI_REPOSITORY, "us-docker.pkg.dev/acme/apps/app"],
			];
		for (const [name, kind, locator] of defined) {
			const outcome = await sources.define(
				create(FreightSourceRecordSchema, {
					name,
					bindle: "web",
					subscriptions: [
						sub(
							kind === Kind.GIT_REPOSITORY
								? { name: "s", kind, locator, branch: "main" }
								: { name: "s", kind, locator },
						),
					],
				}),
				ctx,
			);
			if (!outcome.ok)
				throw new Error(`${name}: ${JSON.stringify(outcome.reasons)}`);
		}
		for (const item of webhooksPact.interactions) {
			const request = item.request;
			const response = await sources.nudge(
				{
					method: request.method,
					path: `${request.path}${"query" in request && isText(request.query) ? `?${request.query}` : ""}`,
					headers: request.headers,
					body: encode(request.body.content),
				},
				ctx,
			);
			expect(response.status, item.description).toBe(item.response.status);
			if (
				"body" in item.response &&
				isRecord(item.response.body) &&
				response.body instanceof Uint8Array
			) {
				expect(
					JSON.parse(new TextDecoder().decode(response.body)),
					item.description,
				).toEqual(JSON.parse(String(item.response.body.content)));
			}
		}
		expect(ledger.calls).toEqual([]);
	});
});
