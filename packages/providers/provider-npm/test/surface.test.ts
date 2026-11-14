import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
	createBoundedFetchTransport,
	parseTrafficRoutingProviderProfile,
	resolveTrafficRouting,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	compareIntegrity,
	NPM_PACKAGE_VERSION_PRODUCT_ID,
	NPM_TRAFFIC_ROUTING_ABSENT,
	NPM_TRAFFIC_ROUTING_PROFILE,
	npmResolverRegistry,
	parseNpmTarball,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
import {
	digestOf,
	memoryStore,
	options,
	registryWorld,
	request,
	TARBALL,
} from "./support/world.js";

/** A minimal ustar archive, optionally with a PAX `path` record for the manifest. */
function tarOf(entries: [string, string][], pax = false): Uint8Array {
	const blocks: Buffer[] = [];
	const header = (name: string, size: number, type: string) => {
		const block = Buffer.alloc(512);
		block.write(name.slice(0, 99), 0);
		block.write("0000644\0", 100);
		block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
		block.write(type, 156);
		block.write("ustar\0", 257);
		block.write("00", 263);
		block.write("        ", 148);
		let sum = 0;
		for (const byte of block) sum += byte;
		block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		return block;
	};
	const data = (text: string) => {
		const bytes = Buffer.from(text);
		return Buffer.concat([
			bytes,
			Buffer.alloc((512 - (bytes.length % 512)) % 512),
		]);
	};
	for (const [name, body] of entries) {
		if (pax) {
			const record = `path=${name}\n`;
			const line = `${record.length + 3} ${record}`;
			blocks.push(header("PaxHeader", line.length, "x"), data(line));
			blocks.push(
				header("ignored-short-name", Buffer.byteLength(body), "0"),
				data(body),
			);
		} else blocks.push(header(name, Buffer.byteLength(body), "0"), data(body));
	}
	blocks.push(Buffer.alloc(1024));
	return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

describe("npm tarball parse boundary", () => {
	it("reads the manifest out of a real npm pack tarball and computes npm's integrity", () => {
		const parsed = parseNpmTarball(TARBALL, digestOf(TARBALL));
		expect(parsed.manifest).toMatchObject({
			name: "@hobo-fixtures/widget",
			version: "1.2.3",
		});
		expect(parsed.integrity).toBe(
			`sha512-${createHash("sha512").update(TARBALL).digest("base64")}`,
		);
		expect(parsed.shasum).toBe(
			createHash("sha1").update(TARBALL).digest("hex"),
		);
	});

	it("follows a PAX path record to the manifest", () => {
		const tgz = tarOf(
			[["package/package.json", '{"name":"a","version":"1.0.0"}']],
			true,
		);
		expect(parseNpmTarball(tgz, digestOf(tgz)).manifest.name).toBe("a");
	});

	it("refuses a tarball without a top-level package.json, a nested one, and non-gzip bytes", () => {
		const none = tarOf([["package/index.js", "x"]]);
		expect(() => parseNpmTarball(none, digestOf(none))).toThrow(
			/no top-level package.json/u,
		);
		const nested = tarOf([
			["package/lib/package.json", '{"name":"a","version":"1.0.0"}'],
		]);
		expect(() => parseNpmTarball(nested, digestOf(nested))).toThrow(
			/no top-level package.json/u,
		);
		const plain = new TextEncoder().encode("not gzip");
		expect(() => parseNpmTarball(plain, digestOf(plain))).toThrow(
			/not a gzip stream/u,
		);
	});

	it("compares Subresource Integrity strictly", () => {
		const sha512 = `sha512-${createHash("sha512").update(TARBALL).digest("base64")}`;
		const sha256 = `sha256-${createHash("sha256").update(TARBALL).digest("base64")}`;
		expect(compareIntegrity(sha512, TARBALL)).toBe("match");
		expect(compareIntegrity(`${sha256} ${sha512}`, TARBALL)).toBe("match");
		expect(compareIntegrity(`${sha512} sha256-AAAA`, TARBALL)).toBe("mismatch");
		expect(compareIntegrity("sha1-abc", TARBALL)).toBe("incomparable");
	});
});

describe("npm traffic routing profile", () => {
	it("is kind other, declares no offering and no fallback, and every offering absent", () => {
		const profile = parseTrafficRoutingProviderProfile(
			JSON.parse(JSON.stringify(NPM_TRAFFIC_ROUTING_PROFILE)),
		);
		expect(profile.provider).toBe("other");
		expect(profile.offerings).toEqual([]);
		expect(profile.fallbacks).toEqual([]);
		expect(
			new Set(NPM_TRAFFIC_ROUTING_ABSENT.map((entry) => entry.offeringId)).size,
		).toBe(17);
		const routed = resolveTrafficRouting([profile], {
			features: ["edge.canary"],
			negotiation: "require",
		});
		expect(routed.kind).toBe("unresolved");
	});
});

const CUE_BIN =
	process.env.HOBO_CUE_BIN ??
	fileURLToPath(new URL("../../../../.tools/cue/v0.14.0/cue", import.meta.url));

function cueVet(definition: string, value: JsonValue | undefined): void {
	const directory = mkdtempSync(join(tmpdir(), "provider-npm-cue-"));
	try {
		const file = join(directory, "document.json");
		writeFileSync(file, JSON.stringify(value));
		execFileSync(
			CUE_BIN,
			[
				"vet",
				fileURLToPath(
					new URL("../data-models/provider_npm.cue", import.meta.url),
				),
				file,
				"-d",
				definition,
			],
			{ stdio: "pipe" },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(CUE_BIN))(
	"npm data models vet real records (skipped: no cue binary; set HOBO_CUE_BIN)",
	() => {
		it("vets the desired state and the observed outputs of a real reconcile", async () => {
			const world = registryWorld();
			const outcome = await npmResolverRegistry(options(memoryStore(TARBALL)))
				.get(NPM_PACKAGE_VERSION_PRODUCT_ID)
				?.reconcile(request(), world.transport);
			cueVet("#NpmPackageVersionDesired", request().desired);
			cueVet("#NpmPackageVersionOutputs", outcome?.outputs);
			expect(() =>
				cueVet("#NpmPackageVersionDesired", {
					...request().desired,
					distTag: "v2",
				}),
			).toThrow();
			expect(() =>
				cueVet("#NpmPackageVersionOutputs", {
					...outcome?.outputs,
					ready: true,
					lifecycleStatus: "pending",
				}),
			).toThrow();
		});
	},
);

const live = {
	registry: process.env.HOBO_NPM_LIVE_REGISTRY,
	token: process.env.HOBO_NPM_LIVE_TOKEN,
	packageName: process.env.HOBO_NPM_LIVE_PACKAGE,
	version: process.env.HOBO_NPM_LIVE_VERSION,
	distTag: process.env.HOBO_NPM_LIVE_DIST_TAG,
	tarball: process.env.HOBO_NPM_LIVE_TARBALL,
};
describe.skipIf(!Object.values(live).every(Boolean))(
	"npm live lane (read-only; skipped: set HOBO_NPM_LIVE_REGISTRY=https://registry.npmjs.org, HOBO_NPM_LIVE_TOKEN, HOBO_NPM_LIVE_PACKAGE, HOBO_NPM_LIVE_VERSION, HOBO_NPM_LIVE_DIST_TAG, HOBO_NPM_LIVE_TARBALL=<path to the published .tgz>)",
	() => {
		it("observes a published version by integrity without mutating anything", async () => {
			const { readFileSync } = await import("node:fs");
			const bytes = new Uint8Array(readFileSync(String(live.tarball)));
			const outcome = await npmResolverRegistry(
				options(memoryStore(bytes), {
					resolveCredential: async () => String(live.token),
				}),
			)
				.get(NPM_PACKAGE_VERSION_PRODUCT_ID)
				?.read?.(
					request({
						registry: String(live.registry),
						packageName: String(live.packageName),
						version: String(live.version),
						distTag: String(live.distTag),
						artifactDigest: digestOf(bytes),
					}),
					createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
				);
			expect(outcome?.physicalId).toBe(`${live.packageName}@${live.version}`);
			expect(JSON.stringify(outcome)).not.toContain(String(live.token));
		});
	},
);

// Opt-in write lane for the one unverified routing claim: a scoped name sent
// unescaped (the transport guard refuses %2f) to the dist-tag route. It moves
// HOBO_NPM_LIVE_PROMOTE_TAG to the live version; use a scratch tag.
const promoteTag = process.env.HOBO_NPM_LIVE_PROMOTE_TAG;
describe.skipIf(!(promoteTag && Object.values(live).every(Boolean)))(
	"npm live lane (writes one dist-tag; skipped: set the read-only lane's variables plus HOBO_NPM_LIVE_PROMOTE_TAG=<scratch tag> on a scoped package)",
	() => {
		it("moves a dist-tag on a scoped package through the unescaped route and observes it", async () => {
			const { readFileSync } = await import("node:fs");
			const bytes = new Uint8Array(readFileSync(String(live.tarball)));
			expect(String(live.packageName).startsWith("@")).toBe(true);
			const outcome = await npmResolverRegistry(
				options(memoryStore(bytes), {
					resolveCredential: async () => String(live.token),
				}),
			)
				.get(NPM_PACKAGE_VERSION_PRODUCT_ID)
				?.reconcile(
					request({
						registry: String(live.registry),
						packageName: String(live.packageName),
						version: String(live.version),
						distTag: String(promoteTag),
						artifactDigest: digestOf(bytes),
					}),
					createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
				);
			expect(outcome?.outputs.distTagVersion).toBe(live.version);
			expect(JSON.stringify(outcome)).not.toContain(String(live.token));
		});
	},
);
