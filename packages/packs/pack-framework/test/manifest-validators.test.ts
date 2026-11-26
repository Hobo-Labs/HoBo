/**
 * The pack manifest's individual validators.
 *
 * `manifest.test.ts` drives a table of cases; this goes at each validator's
 * boundary conditions directly, since those are where a manifest that looks
 * fine produces a pack that behaves badly at runtime.
 *
 * Several of these checks encode a judgement rather than a format rule, and
 * those are the ones worth pinning with their reasoning:
 *
 *   - **One repository per pack.** A manifest whose arm64 image comes from a
 *     different repository than its amd64 image is describing two products,
 *     and nothing downstream would notice.
 *   - **`timeoutMs` may not exceed `periodMs`.** Otherwise probes overlap
 *     themselves, and the failure looks like flapping rather than
 *     misconfiguration.
 *   - **A pack declaring no persistence must say why.** The rationale turns an
 *     omission into a decision — otherwise "no volumes" is indistinguishable
 *     from "nobody thought about it", and the pack that loses data on restart
 *     looks exactly like the one that legitimately has none.
 *   - **A probe may only reference a declared port.** A readiness probe
 *     pointing at a port that does not exist never passes, and the pack never
 *     starts, with nothing saying why.
 *
 * Sorting is asserted throughout: the manifest is digested and signed, so a
 * canonical order is what makes two equivalent manifests the same bytes.
 */
import { describe, expect, it } from "vitest";

import {
	type PackManifestInput,
	parsePackId,
	parsePackManifest,
	parsePackVersion,
} from "../src/manifest.js";
import {
	FIXTURE_DIGEST_AMD64,
	FIXTURE_DIGEST_ARM64,
	fixtureManifest,
} from "./harness.js";

type ManifestDraft = Omit<PackManifestInput, "signature">;

const parse = (mutate: (draft: ManifestDraft) => ManifestDraft) =>
	parsePackManifest(fixtureManifest(mutate));

const image = (
	architecture: string,
	repo = "registry.example.test/example/pack",
	digest = FIXTURE_DIGEST_AMD64,
) => ({
	architecture,
	reference: `${repo}@${digest}`,
});

describe("parsePackId", () => {
	it.each([
		["pack.postgres.oci/v1", "postgres", 1],
		["pack.valkey/v2", "valkey", 2],
		["pack.a.b.c/v10", "a", 10],
	])("parses %s", (id, family, major) => {
		const parsed = parsePackId(id);
		expect(parsed.family).toBe(family);
		expect(parsed.major).toBe(major);
	});

	it("collects the qualifiers between family and version", () => {
		expect(parsePackId("pack.postgres.oci.ha/v1").qualifiers).toEqual([
			"oci",
			"ha",
		]);
	});

	it("reports no qualifiers when there are none", () => {
		expect(parsePackId("pack.postgres/v1").qualifiers).toEqual([]);
	});

	it.each([
		"postgres/v1",
		"pack.Postgres/v1",
		"pack.postgres",
		"pack.postgres/v",
		"pack.postgres/1",
		"pack./v1",
		"",
	])("rejects the malformed id %s", (id) => {
		expect(() => parsePackId(id)).toThrow();
	});
});

describe("parsePackVersion", () => {
	it.each(["0.0.0", "1.2.3", "10.20.30"])("accepts %s", (version) => {
		expect(parsePackVersion(version)).toBe(version);
	});

	it.each([
		"1.2",
		"1.2.3.4",
		"v1.2.3",
		"01.2.3",
		"1.02.3",
		"",
		"1.2.x",
	])("rejects %s", (version) => {
		// Leading zeros are rejected so two spellings of one version cannot
		// both exist — a signed manifest's version is an identity.
		expect(() => parsePackVersion(version)).toThrow();
	});
});

describe("images", () => {
	it("requires at least one pinned image", () => {
		expect(() => parse((d) => ({ ...d, images: [] }))).toThrow(
			/at least one image digest/u,
		);
	});

	it("refuses the same architecture twice", () => {
		// Two entries for one architecture is a manifest with two answers.
		expect(() =>
			parse((d) => ({
				...d,
				images: [image("linux/amd64"), image("linux/amd64")],
			})),
		).toThrow(/more than once/u);
	});

	it("refuses images from more than one repository", () => {
		// A manifest whose arm64 image comes from a different repository is
		// describing two products, and nothing downstream would notice.
		expect(() =>
			parse((d) => ({
				...d,
				images: [
					image("linux/amd64", "registry.example.test/a"),
					image("linux/arm64", "registry.example.test/b", FIXTURE_DIGEST_ARM64),
				],
			})),
		).toThrow(/every architecture must come from one/u);
	});

	it("sorts images by architecture, since the manifest is digested", () => {
		const parsed = parse((d) => ({
			...d,
			images: [
				image("linux/arm64", undefined, FIXTURE_DIGEST_ARM64),
				image("linux/amd64"),
			],
		}));
		expect(parsed.images.map((i) => i.architecture)).toEqual([
			"linux/amd64",
			"linux/arm64",
		]);
	});

	it("lifts the digest and repository out of the reference", () => {
		const parsed = parse((d) => d);
		expect(parsed.images[0]?.digest).toBeTruthy();
		expect(parsed.images[0]?.repository).toContain("registry.example.test");
	});

	it.each([0, -1, 1.5])("rejects the size %s", (sizeBytes) => {
		expect(() =>
			parse((d) => ({
				...d,
				images: [{ ...image("linux/amd64"), sizeBytes }],
			})),
		).toThrow(/positive integer/u);
	});

	it("accepts a declared positive size", () => {
		const parsed = parse((d) => ({
			...d,
			images: [{ ...image("linux/amd64"), sizeBytes: 1024 }],
		}));
		expect(parsed.images[0]?.sizeBytes).toBe(1024);
	});

	it("omits size when undeclared", () => {
		expect(parse((d) => d).images[0]).not.toHaveProperty("sizeBytes");
	});
});

describe("ports", () => {
	const port = (overrides: JsonObject = {}) => ({
		name: "main",
		containerPort: 6379,
		protocol: "tcp",
		exposure: "camp",
		...overrides,
	});

	it.each([
		"Main",
		"main_port",
		"-main",
		"main-",
		"",
	])("rejects the port name %s", (name) => {
		expect(() => parse((d) => ({ ...d, ports: [port({ name })] }))).toThrow(
			/lowercase dns-style label/u,
		);
	});

	it("rejects a duplicate port name", () => {
		expect(() =>
			parse((d) => ({
				...d,
				ports: [port(), port({ containerPort: 6380 })],
				probes: {},
			})),
		).toThrow(/duplicate port name/u);
	});

	it.each([
		0, -1, 65536, 1.5,
	])("rejects the out-of-range container port %s", (containerPort) => {
		expect(() =>
			parse((d) => ({ ...d, ports: [port({ containerPort })] })),
		).toThrow(/out-of-range containerPort/u);
	});

	it.each([1, 65535])("accepts the boundary port %d", (containerPort) => {
		expect(() =>
			parse((d) => ({ ...d, ports: [port({ containerPort })] })),
		).not.toThrow();
	});

	it("sorts ports by name", () => {
		const parsed = parse((d) => ({
			...d,
			ports: [
				port({ name: "zeta", containerPort: 1 }),
				port({ name: "alpha", containerPort: 2 }),
			],
		}));
		expect(parsed.ports.map((p) => p.name)).toEqual(["alpha", "zeta"]);
	});
});

describe("probes", () => {
	const exec = (overrides: JsonObject = {}) => ({
		kind: "exec",
		argv: ["/bin/check"],
		initialDelayMs: 500,
		periodMs: 2000,
		timeoutMs: 1000,
		failureThreshold: 3,
		...overrides,
	});

	const withProbe = (probe: JsonObject) => (d: JsonObject) => ({
		...d,
		probes: { readiness: probe },
	});

	it.each([
		"initialDelayMs",
		"periodMs",
		"timeoutMs",
		"failureThreshold",
	])("rejects a negative %s", (field) => {
		expect(() => parse(withProbe(exec({ [field]: -1 })))).toThrow(
			/non-negative integer/u,
		);
	});

	it.each([
		"periodMs",
		"timeoutMs",
		"failureThreshold",
	])("rejects a zero %s", (field) => {
		// A zero period is not a probe; a zero threshold never fails.
		expect(() => parse(withProbe(exec({ [field]: 0 })))).toThrow(
			/must be positive/u,
		);
	});

	it("permits a zero initial delay", () => {
		// Checking immediately is a legitimate choice, unlike a zero period.
		expect(() => parse(withProbe(exec({ initialDelayMs: 0 })))).not.toThrow();
	});

	it("rejects a timeout longer than the period", () => {
		// Otherwise probes overlap themselves, and the failure looks like
		// flapping rather than misconfiguration.
		expect(() =>
			parse(withProbe(exec({ periodMs: 1000, timeoutMs: 2000 }))),
		).toThrow(/probes overlap themselves/u);
	});

	it("permits a timeout equal to the period", () => {
		expect(() =>
			parse(withProbe(exec({ periodMs: 1000, timeoutMs: 1000 }))),
		).not.toThrow();
	});

	it("rejects an exec probe with no argv", () => {
		expect(() => parse(withProbe(exec({ argv: [] })))).toThrow(
			/non-empty argv array/u,
		);
	});

	it("rejects an empty argv element", () => {
		expect(() => parse(withProbe(exec({ argv: ["/bin/check", ""] })))).toThrow(
			/free of control characters/u,
		);
	});

	it("rejects a control character in argv", () => {
		// Container runtimes echo the command line back; a control character
		// there can forge a log record.
		expect(() => parse(withProbe(exec({ argv: ["/bin/check ready"] })))).toThrow(
			/free of control characters/u,
		);
	});

	it("rejects a probe referencing an undeclared port", () => {
		// A readiness probe pointing at a port that does not exist never passes,
		// and the pack never starts with nothing saying why.
		expect(() =>
			parse(
				withProbe({
					kind: "tcp",
					portName: "absent",
					initialDelayMs: 0,
					periodMs: 1000,
					timeoutMs: 500,
					failureThreshold: 3,
				}),
			),
		).toThrow(/undeclared port/u);
	});

	it("accepts a probe referencing a declared port", () => {
		expect(() =>
			parse(
				withProbe({
					kind: "tcp",
					portName: "main",
					initialDelayMs: 0,
					periodMs: 1000,
					timeoutMs: 500,
					failureThreshold: 3,
				}),
			),
		).not.toThrow();
	});

	it("rejects an http-get path that is not absolute", () => {
		expect(() =>
			parse(
				withProbe({
					kind: "http-get",
					portName: "main",
					path: "health",
					expectStatus: 200,
					initialDelayMs: 0,
					periodMs: 1000,
					timeoutMs: 500,
					failureThreshold: 3,
				}),
			),
		).toThrow(/must start with \//u);
	});

	it.each([
		99, 0, -1, 1.5,
	])("rejects the http-get expectStatus %s", (expectStatus) => {
		expect(() =>
			parse(
				withProbe({
					kind: "http-get",
					portName: "main",
					path: "/health",
					expectStatus,
					initialDelayMs: 0,
					periodMs: 1000,
					timeoutMs: 500,
					failureThreshold: 3,
				}),
			),
		).toThrow(/valid HTTP status/u);
	});
});

describe("persistence", () => {
	const volume = (overrides: JsonObject = {}) => ({
		name: "data",
		mountPath: "/var/lib/example",
		minimumBytes: 1024,
		accessMode: "single-writer",
		...overrides,
	});

	const withPersistence = (persistence: JsonObject) => (d: JsonObject) => ({
		...d,
		persistence,
	});

	it("requires a rationale when a pack declares no persistence", () => {
		// The rationale turns an omission into a decision: without it, "no
		// volumes" is indistinguishable from "nobody thought about it".
		expect(() =>
			parse(
				withPersistence({
					requirement: "not-applicable",
					rationale: "",
					volumes: [],
				}),
			),
		).toThrow(/must say why/u);
	});

	it("rejects a whitespace-only rationale", () => {
		expect(() =>
			parse(
				withPersistence({
					requirement: "not-applicable",
					rationale: "   ",
					volumes: [],
				}),
			),
		).toThrow(/must say why/u);
	});

	it("accepts a stated rationale", () => {
		expect(() =>
			parse(
				withPersistence({
					requirement: "not-applicable",
					rationale: "stateless request handler",
					volumes: [],
				}),
			),
		).not.toThrow();
	});

	it("requires a volume when persistence is required", () => {
		expect(() =>
			parse(withPersistence({ requirement: "required", volumes: [] })),
		).toThrow(/at least one volume/u);
	});

	it.each([
		"Data",
		"data_vol",
		"-data",
		"data-",
		"",
	])("rejects the volume name %s", (name) => {
		expect(() =>
			parse(
				withPersistence({
					requirement: "required",
					volumes: [volume({ name })],
				}),
			),
		).toThrow(/lowercase dns-style label/u);
	});

	it("rejects a duplicate volume name", () => {
		expect(() =>
			parse(
				withPersistence({
					requirement: "required",
					volumes: [volume(), volume({ mountPath: "/other" })],
				}),
			),
		).toThrow(/duplicate volume name/u);
	});

	it("rejects a duplicate mount path", () => {
		// Two volumes at one path is a pack whose data location is ambiguous.
		expect(() =>
			parse(
				withPersistence({
					requirement: "required",
					volumes: [volume(), volume({ name: "other" })],
				}),
			),
		).toThrow(/duplicate volume mountPath/u);
	});

	it.each([
		"relative/path",
		"",
		"var/lib",
	])("rejects the non-absolute mount path %s", (mountPath) => {
		expect(() =>
			parse(
				withPersistence({
					requirement: "required",
					volumes: [volume({ mountPath })],
				}),
			),
		).toThrow(/absolute path without traversal/u);
	});

	it("rejects a traversal segment in a mount path", () => {
		expect(() =>
			parse(
				withPersistence({
					requirement: "required",
					volumes: [volume({ mountPath: "/var/../etc" })],
				}),
			),
		).toThrow(/absolute path without traversal/u);
	});

	it.each([0, -1, 1.5])("rejects the volume size %s", (minimumBytes) => {
		expect(() =>
			parse(
				withPersistence({
					requirement: "required",
					volumes: [volume({ minimumBytes })],
				}),
			),
		).toThrow(/positive integer/u);
	});

	it("sorts volumes by name", () => {
		const parsed = parse(
			withPersistence({
				requirement: "required",
				volumes: [
					volume({ name: "zeta", mountPath: "/z" }),
					volume({ name: "alpha", mountPath: "/a" }),
				],
			}),
		);
		expect(parsed.persistence.volumes?.map((v) => v.name)).toEqual([
			"alpha",
			"zeta",
		]);
	});
});
