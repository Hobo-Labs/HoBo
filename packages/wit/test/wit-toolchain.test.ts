import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import pact from "../contracts/pacts/wit-contract-registry.pact.json";
import {
	buildComponentManifest,
	compareForwardReverse,
	compareSurfaces,
	extractComponentSurface,
	extractWitContract,
	loadToolchainLock,
	parseInterfacePin,
	verifyVendoredWit,
	WitDigestMismatchError,
} from "../src/index.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOCK_PATH = join(PACKAGE_ROOT, "wit-lock.json");
const WIT_PATH = join(PACKAGE_ROOT, "wit", "hobo-sdk.wit");

describe("@hobo/wit contract registry pact", () => {
	it("documents consumer and provider names", () => {
		expect(pact.consumer.name).toBe("WitBindingCodegenConsumer");
		expect(pact.provider.name).toBe("WitContractRegistry");
	});

	it("fetch lock interaction matches pinned interface list response", async () => {
		const lock = await loadToolchainLock(LOCK_PATH);
		const interaction = pact.interactions[0];
		expect(interaction.response.body.schema).toBe(lock.schema);
		expect(interaction.response.body.package).toBe(lock.package);
		expect(lock.witDeps.length).toBeGreaterThan(0);
	});

	it("digest mismatch interaction matches typed error envelope", async () => {
		const lock = await loadToolchainLock(LOCK_PATH);
		const drifted = {
			...lock,
			witDeps: lock.witDeps.map((pin, index) =>
				index === 0
					? {
							...pin,
							sha256:
								"sha256:0000000000000000000000000000000000000000000000000000000000000000",
						}
					: pin,
			),
		};

		await expect(
			verifyVendoredWit(drifted, PACKAGE_ROOT),
		).rejects.toBeInstanceOf(WitDigestMismatchError);
	});

	it("surface comparison interaction matches parity report shape", () => {
		const forward = extractComponentSurface({
			imports: ["workflow", "actor"],
			exports: [],
		});
		const reverse = extractComponentSurface({
			imports: ["workflow", "crypto"],
			exports: [],
		});
		const report = compareSurfaces(forward, reverse);
		expect(report.parity).toBe("drifted");
		expect(report.driftedImports).toEqual(["actor", "crypto"]);
	});
});

describe("parseInterfacePin", () => {
	it("parses namespace:package/interface@semver@stability pins", () => {
		const pin = parseInterfacePin("wasi:keyvalue/store@0.2.0@preview");
		expect(pin.namespace).toBe("wasi");
		expect(pin.packageName).toBe("keyvalue");
		expect(pin.interfaceName).toBe("store");
		expect(pin.stability).toBe("preview");
	});

	it("rejects malformed pin ids", () => {
		expect(() => parseInterfacePin("not-a-pin")).toThrow(/wit\.pin\.invalid/);
	});
});

describe("toolchain lock verification", () => {
	it("verifies all vendored WIT deps against wit-lock.json", async () => {
		const lock = await loadToolchainLock(LOCK_PATH);
		const verification = await verifyVendoredWit(lock, PACKAGE_ROOT);
		expect(verification.verified).toBe(lock.witDeps.length);
		expect(
			verification.pins.every((pin) => pin.sha256.startsWith("sha256:")),
		).toBe(true);
	});

	it("fails closed on digest mismatch naming the pin", async () => {
		const lock = await loadToolchainLock(LOCK_PATH);
		const drifted = {
			...lock,
			witDeps: lock.witDeps.map((pin, index) =>
				index === 0 ? { ...pin, sha256: `${pin.sha256.slice(0, -1)}0` } : pin,
			),
		};

		await expect(
			verifyVendoredWit(drifted, PACKAGE_ROOT),
		).rejects.toMatchObject({
			code: "wit.digest_mismatch",
			pinId: drifted.witDeps[0].id,
		});
	});

	it("records ADR-0085 compat floor pins", async () => {
		const lock = await loadToolchainLock(LOCK_PATH);
		expect(lock.canonicalGenerator).toEqual({
			name: "@bytecodealliance/jco",
			version: "1.24.3",
			role: "canonical-ts-bindings",
		});
		expect(lock.compatFloor).toEqual({
			wasmtime: "46.0.1",
			componentizeJs: "0.21.0",
			wrpc: "0.17.0",
			wasmCloud: "2.4.0",
			defaultTransport: "wrpc@0.17.0+nats",
		});
		expect(lock.smokeGenerators[0]?.name).toBe("wit-bindgen-cli");
	});
});

describe("forward/reverse surface parity", () => {
	it("generates async durable messaging operations and keeps unknown and expired distinct", async () => {
		const { readFile } = await import("node:fs/promises");
		const path = join(
			PACKAGE_ROOT,
			"src/generated/sdk/interfaces/hobo-durable-messaging-messaging.d.ts",
		);
		const types = await readFile(path, "utf8");
		for (const method of [
			"ensureTopic",
			"ensureSubscription",
			"publish",
			"consume",
			"ack",
			"nack",
			"compact",
			"events",
		]) {
			expect(types).toMatch(
				new RegExp(`export function ${method}\\([^\\n]*\\): Promise<`, "u"),
			);
		}
		expect(types).toContain("MessageOutcomeUnknown");
		expect(types).toContain("MessageOutcomeExpired");
	});

	it("matches golden component imports against hobo:sdk world", async () => {
		const { readFile } = await import("node:fs/promises");
		const wit = await readFile(WIT_PATH, "utf8");
		const declared = extractWitContract(wit);
		const artifact = {
			artifact: "fixtures/golden-sdk-component.wasm",
			imports: [
				"hobo:runtime/workflow@0.1.0",
				"hobo:runtime/actor@0.1.0",
				"hobo:runtime/saga@0.1.0",
				"hobo:runtime/agent@0.1.0",
				"hobo:runtime/command@0.1.0",
				"hobo:runtime/subscribe@0.1.0",
				"hobo:queue/queue@0.1.0",
				"hobo:durable-messaging/messaging@0.1.0",
				"hobo:scheduler/scheduler@0.1.0",
				"hobo:blob-events/blob-events@0.1.0",
				"hobo:evidence/evidence@0.1.0",
			],
			// SAFETY: the fixture deliberately contains no component exports.
			exports: [] as string[],
		};
		const manifest = buildComponentManifest(declared, artifact);
		const report = compareForwardReverse(declared, manifest);
		expect(report.ok).toBe(true);
		expect(report.report.parity).toBe("matched");
	});

	it("refuses drifted imports with parity drifted", () => {
		const forward = extractComponentSurface({
			imports: ["workflow", "data"],
			exports: [],
		});
		const reverse = extractComponentSurface({
			imports: ["workflow", "crypto"],
			exports: [],
		});
		const report = compareSurfaces(forward, reverse);
		expect(report.parity).toBe("drifted");
		expect(report.driftedImports).toEqual(["data", "crypto"]);
	});
});
