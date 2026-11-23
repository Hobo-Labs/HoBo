import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	create,
	fromBinary,
	fromJsonString,
	toBinary,
	toJson,
} from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	BindleDeploymentRequestSchema,
	PlacementLabelEntrySchema,
	YardPlacementRequestSchema,
} from "../src/_generated/yard_placement_pb.js";
import {
	buildDeploymentRequestFromParts,
	contentHashOf,
	createLocalHostCatalog,
	decodeBindleDeploymentRequest,
	encodeBindleDeploymentRequest,
	LOCAL_HOST_PROVIDER_ID,
	parseBindleDeploymentRequest,
	prepareYardHostingWork,
	resolveBindleDeployment,
} from "../src/index.js";
import { cloneAsJson } from "../src/json.js";
import { approveLocalHosting } from "./helpers/local-hosting.js";

const YARD_LAYOUT_FIELD = "requestedShape";

it("preserves Yard placement inputs through a protobuf round trip", () => {
	const document = {
		schemaVersion: "hobo.bindle-deployment-request/v1",
		requestId: "request-1",
		bindleName: "shop",
		manifestHash: "sha256:manifest",
		objective: "min-cost",
		spendEstimateUsd: 4,
		ownerTenantId: "tenant",
		yard: {
			requestId: "yard-request-1",
			selectionMode: "exact",
			requestedYardId: "yard:eu",
			[YARD_LAYOUT_FIELD]: {
				providerId: "provider",
				regions: ["eu"],
				require: ["secure"],
				prefer: [],
				canonicalLabels: [{ key: "owner", value: "team" }],
				residency: ["eu"],
				isolation: ["isolated"],
				network: ["private"],
				componentHosts: ["wasm"],
				propertiesJson: '{"replicas":2,"tier":"gold"}',
				camps: [
					{ id: "camp:prod", envType: "production", require: ["secure"] },
				],
			},
			bindleManifestHash: "sha256:manifest",
			bindleRequirementsHash: "sha256:requirements",
			allowGenerationRequested: false,
		},
		bindleRequirements: {
			require: ["database"],
			prefer: [],
			runtimes: ["wasm"],
			canonicalLabels: [{ key: "tier", value: "prod" }],
		},
		resources: [
			{
				resourceId: "db",
				port: "storage",
				features: ["encrypted"],
				region: "eu",
			},
		],
		camp: {
			selectionMode: "exact",
			campId: "camp:prod",
			layout: { envType: "production", require: ["secure"] },
		},
		requestDigest: "sha256:digest",
	};
	const encoded = fromJsonString(
		BindleDeploymentRequestSchema,
		JSON.stringify(document),
		{ ignoreUnknownFields: true },
	);
	const decoded = fromBinary(
		BindleDeploymentRequestSchema,
		toBinary(BindleDeploymentRequestSchema, encoded),
	);
	expect(
		toJson(BindleDeploymentRequestSchema, decoded, {
			alwaysEmitImplicit: true,
		}),
	).toMatchObject({
		yard: { [YARD_LAYOUT_FIELD]: document.yard[YARD_LAYOUT_FIELD] },
		bindleRequirements: document.bindleRequirements,
		resources: document.resources,
		camp: document.camp,
		requestDigest: "sha256:digest",
	});
});

const base = buildDeploymentRequestFromParts({
	bindleName: "shop",
	providerId: LOCAL_HOST_PROVIDER_ID,
	yardId: "yard:local-main",
	resources: [{ resourceId: "api", port: "hobo:http-service", features: [] }],
});

function completeRequest() {
	return parseBindleDeploymentRequest(
		cloneAsJson({
			...base,
			spendEstimateUsd: 3.25,
			bindleRequirements: {
				require: ["database"],
				prefer: ["fast"],
				runtimes: ["wasm"],
				labels: { team: "payments" },
			},
			yard: {
				...base.yard,
				requestedLayout: {
					...base.yard.requestedLayout,
					runtimeId: "runtime:v1",
					regions: ["eu"],
					require: ["secure"],
					prefer: ["fast"],
					residency: ["eu"],
					isolation: ["isolated"],
					network: ["private"],
					labels: { purpose: "shop" },
					properties: { nested: { number: 3, flag: true, array: ["x", null] } },
					camps: [
						{
							id: "payments",
							env: "blue",
							envType: "production",
							require: ["secure"],
							labels: { team: "ops" },
							runtimeRequirements: ["node"],
						},
					],
				},
			},
			camp: {
				selectionMode: "exact",
				campId: "camp:production",
				layout: {
					id: "payments",
					env: "blue",
					envType: "production",
					require: ["secure"],
					prefer: ["fast"],
					labels: { team: "ops" },
					runtimeRequirements: ["node"],
				},
			},
			resources: [
				{
					resourceId: "database",
					port: "storage",
					features: ["encrypted"],
					region: "eu",
				},
				{ resourceId: "api", port: "http", features: [] },
			],
		}),
	);
}

describe("complete Yard placement request wire binding", () => {
	it("preserves the full request and the digest authorized by quoting", () => {
		const request = completeRequest();
		const decoded = decodeBindleDeploymentRequest(
			encodeBindleDeploymentRequest(request),
		);
		expect(decoded).toEqual(request);
		expect(contentHashOf(decoded)).toBe(contentHashOf(request));
		expect(Object.isFrozen(decoded)).toBe(true);
	});

	it("preserves both quoted work and the selected Camp through the public API", async () => {
		const request = parseBindleDeploymentRequest(
			cloneAsJson({
				...base,
				camp: {
					selectionMode: "compatible",
					layout: { envType: "production" },
				},
			}),
		);
		const decoded = decodeBindleDeploymentRequest(
			encodeBindleDeploymentRequest(request),
		);
		const catalog = createLocalHostCatalog();
		const prepare = (input: typeof request) =>
			prepareYardHostingWork({
				request: input,
				brokerId: "broker:test",
				ownerTenantId: "local",
				catalog,
				yardId: "yard:local-main",
				providerId: LOCAL_HOST_PROVIDER_ID,
			});
		const originalWork = prepare(request);
		const decodedWork = prepare(decoded);
		if ("error" in originalWork || "error" in decodedWork)
			throw new Error("work planning failed");
		expect(decodedWork.workDigest).toBe(originalWork.workDigest);
		const result = await resolveBindleDeployment(decoded, {
			brokerId: "broker:test",
			catalog,
			authorizeLocalHosting: approveLocalHosting,
		});
		expect(result.outcome).toBe("resolved");
		expect(result.receipt?.selectedCampId).toBe(
			"yard:local-main/camp:production",
		);
	});

	it("round-trips generated constraints, environments, and resource requests", () => {
		fc.assert(
			fc.property(
				fc.constantFrom("dev", "staging", "production", "é"),
				fc.array(fc.constantFrom("fast", "secure", "regional"), {
					maxLength: 3,
				}),
				fc.boolean(),
				fc.integer({ min: 0, max: 100_000 }),
				(environment, constraints, regional, cents) => {
					const request = parseBindleDeploymentRequest(
						cloneAsJson({
							...base,
							spendEstimateUsd: cents / 100,
							yard: {
								...base.yard,
								requestedLayout: {
									...base.yard.requestedLayout,
									require: constraints,
									properties: { env: environment, nested: [null, cents] },
								},
							},
							camp: {
								selectionMode: "compatible",
								layout: { envType: environment, env: "" },
							},
							resources: [
								{
									resourceId: "api",
									port: "http",
									features: constraints,
									...(regional ? { region: "eu" } : undefined),
								},
							],
						}),
					);
					expect(
						decodeBindleDeploymentRequest(
							encodeBindleDeploymentRequest(request),
						),
					).toEqual(request);
				},
			),
			{ seed: 614_578, numRuns: 100 },
		);
	});

	it("distinguishes an explicit zero estimate from a missing estimate", () => {
		const message = fromBinary(
			BindleDeploymentRequestSchema,
			encodeBindleDeploymentRequest(base),
		);
		expect(message.spendEstimateUsd).toBe(0);
		expect(
			decodeBindleDeploymentRequest(
				toBinary(BindleDeploymentRequestSchema, message),
			).spendEstimateUsd,
		).toBe(0);
		message.spendEstimateUsd = undefined;
		expect(() =>
			decodeBindleDeploymentRequest(
				toBinary(BindleDeploymentRequestSchema, message),
			),
		).toThrow(/spendEstimateUsd/);
	});

	it("refuses old, incomplete, tampered, and unsupported work snapshots", () => {
		const encoded = encodeBindleDeploymentRequest(completeRequest());
		const mutate = (change: (message: ReturnType<typeof fromWire>) => void) => {
			const message = fromWire(encoded);
			change(message);
			return toBinary(BindleDeploymentRequestSchema, message);
		};
		const old = toBinary(
			BindleDeploymentRequestSchema,
			create(BindleDeploymentRequestSchema, {
				schemaVersion: base.schemaVersion,
				requestId: base.requestId,
			}),
		);
		expect(() => decodeBindleDeploymentRequest(old)).toThrow(/incomplete/);
		for (const bytes of [
			mutate((m) => {
				m.yard = undefined;
			}),
			mutate((m) => {
				m.bindleRequirements = undefined;
			}),
			mutate((m) => {
				if (m.camp) m.camp.layout = undefined;
			}),
			mutate((m) => {
				m.requestDigest = "sha256:invalid";
			}),
			mutate((m) => {
				if (m.resources[0]) m.resources[0].port = "different";
			}),
			mutate((m) => {
				if (m.camp?.layout) m.camp.layout.envType = "staging";
			}),
			mutate((m) => {
				if (m.yard) m.yard.selectionMode = "unknown";
			}),
			mutate((m) => {
				m.spendEstimateUsd = -1;
			}),
			encoded.subarray(0, encoded.length - 1),
		])
			expect(() => decodeBindleDeploymentRequest(bytes)).toThrow();
	});

	it("refuses unknown root and nested placement fields", () => {
		const encoded = encodeBindleDeploymentRequest(completeRequest());
		const extra = [0x98, 0x06, 0x01];
		expect(() =>
			decodeBindleDeploymentRequest(Uint8Array.from([...encoded, ...extra])),
		).toThrow(/unknown/);
		const message = fromWire(encoded);
		if (!message.yard) throw new Error("missing Yard");
		const yardBytes = toBinary(YardPlacementRequestSchema, message.yard);
		message.yard = fromBinary(
			YardPlacementRequestSchema,
			Uint8Array.from([...yardBytes, ...extra]),
		);
		expect(() =>
			decodeBindleDeploymentRequest(
				toBinary(BindleDeploymentRequestSchema, message),
			),
		).toThrow(/unknown/);
	});

	it("rejects incomplete or ambiguous value encodings", () => {
		const encoded = encodeBindleDeploymentRequest(completeRequest());
		const change = (mutate: (message: ReturnType<typeof fromWire>) => void) => {
			const message = fromWire(encoded);
			mutate(message);
			return toBinary(BindleDeploymentRequestSchema, message);
		};
		for (const bytes of [
			change((message) => {
				if (message.yard?.[YARD_LAYOUT_FIELD])
					message.yard[YARD_LAYOUT_FIELD].propertiesJson = undefined;
			}),
			change((message) => {
				if (message.yard?.[YARD_LAYOUT_FIELD])
					message.yard[YARD_LAYOUT_FIELD].propertiesJson = '{"x":1,"x":2}';
			}),
			change((message) => {
				const layout = message.yard?.[YARD_LAYOUT_FIELD];
				if (layout?.propertiesJson !== undefined)
					layout.propertiesJson = ` ${layout.propertiesJson}`;
			}),
			change((message) => {
				if (message.bindleRequirements)
					message.bindleRequirements.canonicalLabels.push(
						create(PlacementLabelEntrySchema, {
							key: "team",
							value: "payments",
						}),
					);
			}),
		])
			expect(() => decodeBindleDeploymentRequest(bytes)).toThrow();
	});

	it("refuses a negative estimate even when its digest is recomputed", () => {
		const request = completeRequest();
		const message = fromWire(encodeBindleDeploymentRequest(request));
		message.spendEstimateUsd = -1;
		message.requestDigest = contentHashOf({ ...request, spendEstimateUsd: -1 });
		expect(() =>
			decodeBindleDeploymentRequest(
				toBinary(BindleDeploymentRequestSchema, message),
			),
		).toThrow(/spendEstimateUsd/);
	});

	it("refuses an exact Camp without an ID even when its digest matches", () => {
		const request = completeRequest();
		const message = fromWire(encodeBindleDeploymentRequest(request));
		if (!request.camp || !message.camp) throw new Error("missing Camp");
		const { campId: _campId, ...camp } = request.camp;
		message.camp.campId = undefined;
		message.requestDigest = contentHashOf({ ...request, camp });
		expect(() =>
			decodeBindleDeploymentRequest(
				toBinary(BindleDeploymentRequestSchema, message),
			),
		).toThrow(/exact.*campId/i);
	});

	it("refuses an exact Yard without an ID even when its digest matches", () => {
		const request = completeRequest();
		const message = fromWire(encodeBindleDeploymentRequest(request));
		if (!message.yard) throw new Error("missing Yard");
		const { requestedYardId: _id, ...yard } = request.yard;
		message.yard.requestedYardId = undefined;
		message.requestDigest = contentHashOf({ ...request, yard });
		expect(() =>
			decodeBindleDeploymentRequest(
				toBinary(BindleDeploymentRequestSchema, message),
			),
		).toThrow(/exact.*requestedYardId/i);
	});

	it("refuses invalid residency even when the digest matches", () => {
		const request = completeRequest();
		const message = fromWire(encodeBindleDeploymentRequest(request));
		const layout = message.yard?.[YARD_LAYOUT_FIELD];
		if (!layout) throw new Error("missing Yard layout");
		layout.residency = ["atlantis"];
		message.requestDigest = contentHashOf({
			...request,
			yard: {
				...request.yard,
				requestedLayout: {
					...request.yard.requestedLayout,
					residency: ["atlantis"],
				},
			},
		});
		expect(() =>
			decodeBindleDeploymentRequest(
				toBinary(BindleDeploymentRequestSchema, message),
			),
		).toThrow(/invalid tag/);
	});

	it("refuses noncanonical wire fields even with a matching normalized digest", () => {
		const request = completeRequest();
		const message = fromWire(encodeBindleDeploymentRequest(request));
		if (!message.bindleRequirements) throw new Error("missing requirements");
		message.bindleRequirements.require = ["z", "a"];
		const normalized = parseBindleDeploymentRequest(
			cloneAsJson({
				...request,
				bindleRequirements: {
					...request.bindleRequirements,
					require: ["z", "a"],
				},
			}),
		);
		message.requestDigest = contentHashOf(normalized);
		expect(() =>
			decodeBindleDeploymentRequest(
				toBinary(BindleDeploymentRequestSchema, message),
			),
		).toThrow(/noncanonical/);
	});

	it("refuses an empty tenant even with a matching digest", () => {
		const request = completeRequest();
		const message = fromWire(encodeBindleDeploymentRequest(request));
		message.ownerTenantId = "";
		message.requestDigest = contentHashOf({ ...request, ownerTenantId: "" });
		expect(() =>
			decodeBindleDeploymentRequest(
				toBinary(BindleDeploymentRequestSchema, message),
			),
		).toThrow(/tenant/);
	});

	it("does not treat a recomputed embedded digest as authorization", () => {
		const request = completeRequest();
		const message = fromWire(encodeBindleDeploymentRequest(request));
		message.ownerTenantId = "other-tenant";
		message.requestDigest = contentHashOf({
			...request,
			ownerTenantId: "other-tenant",
		});
		const decoded = decodeBindleDeploymentRequest(
			toBinary(BindleDeploymentRequestSchema, message),
		);
		expect(decoded.ownerTenantId).toBe("other-tenant");
		expect(contentHashOf(decoded)).not.toBe(contentHashOf(request));
	});

	it("refuses noncanonical requests and invalid estimates at the encoder", () => {
		expect(() =>
			encodeBindleDeploymentRequest({ ...base, spendEstimateUsd: -1 }),
		).toThrow(/spendEstimateUsd/);
		expect(() =>
			encodeBindleDeploymentRequest({ ...base, spendEstimateUsd: Number.NaN }),
		).toThrow(/spendEstimateUsd/);
		expect(() =>
			encodeBindleDeploymentRequest({
				...base,
				yard: {
					...base.yard,
					requestedLayout: {
						...base.yard.requestedLayout,
						require: ["z", "a"],
					},
				},
			}),
		).toThrow(/canonical/);
		expect(() =>
			encodeBindleDeploymentRequest({ ...base, bindleName: "\ud800" }),
		).toThrow(/UTF8|digest mismatch/);
	});
});

function fromWire(bytes: Uint8Array) {
	return fromBinary(BindleDeploymentRequestSchema, bytes);
}

describe("Yard request CUE contract", () => {
	const packageRoot = fileURLToPath(new URL("../", import.meta.url));
	const root = fileURLToPath(new URL("../../../", import.meta.url));
	const cue =
		process.env.HOBO_CUE_BIN ||
		join(
			root,
			".tools/cue/v0.14.0",
			process.platform === "win32" ? "cue.exe" : "cue",
		);
	const schema = join(packageRoot, "data-models/yard_placement.cue");
	const document = JSON.stringify(
		toJson(
			BindleDeploymentRequestSchema,
			fromWire(encodeBindleDeploymentRequest(completeRequest())),
			{ alwaysEmitImplicit: true, useProtoFieldName: true },
		),
	);
	const missingProperties = fromWire(
		encodeBindleDeploymentRequest(completeRequest()),
	);
	if (!missingProperties.yard?.[YARD_LAYOUT_FIELD])
		throw new Error("missing Yard layout");
	missingProperties.yard[YARD_LAYOUT_FIELD].propertiesJson = undefined;
	const missingPropertiesDocument = JSON.stringify(
		toJson(BindleDeploymentRequestSchema, missingProperties, {
			alwaysEmitImplicit: true,
			useProtoFieldName: true,
		}),
	);
	function vet(input: string) {
		const dir = mkdtempSync(join(tmpdir(), "yard-request-cue-"));
		try {
			const file = join(dir, "request.json");
			writeFileSync(file, input);
			return spawnSync(
				cue,
				["vet", "-c", "-d", "#BindleDeploymentRequest", schema, file],
				{ encoding: "utf8", timeout: 15000 },
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	it("accepts the complete protobuf JSON representation", () => {
		const result = vet(document);
		expect(result.status, result.stderr || result.error?.message).toBe(0);
	});
	it("refuses an exact Camp without an ID", () => {
		const request = completeRequest();
		const message = fromWire(encodeBindleDeploymentRequest(request));
		if (!request.camp || !message.camp) throw new Error("missing Camp");
		const { campId: _campId, ...camp } = request.camp;
		message.camp.campId = undefined;
		message.requestDigest = contentHashOf({ ...request, camp });
		const malformed = JSON.stringify(
			toJson(BindleDeploymentRequestSchema, message, {
				alwaysEmitImplicit: true,
				useProtoFieldName: true,
			}),
		);
		const result = vet(malformed);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
	});

	it("refuses an exact Yard without an ID", () => {
		const request = completeRequest();
		const message = fromWire(encodeBindleDeploymentRequest(request));
		if (!message.yard) throw new Error("missing Yard");
		const { requestedYardId: _id, ...yard } = request.yard;
		message.yard.requestedYardId = undefined;
		message.requestDigest = contentHashOf({ ...request, yard });
		const malformed = JSON.stringify(
			toJson(BindleDeploymentRequestSchema, message, {
				alwaysEmitImplicit: true,
				useProtoFieldName: true,
			}),
		);
		const result = vet(malformed);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
	});

	it("agrees with the parser on Yard ID presence and nonblank values", () => {
		const whitespace = [
			...Array.from({ length: 5 }, (_, index) =>
				String.fromCodePoint(9 + index),
			),
			" ",
			"\u00a0",
			"\u1680",
			...Array.from({ length: 11 }, (_, index) =>
				String.fromCodePoint(0x2000 + index),
			),
			"\u2028",
			"\u2029",
			"\u202f",
			"\u205f",
			"\u3000",
			"\ufeff",
		];
		const modes = ["exact", "compatible", "compatible-or-generate"] as const;
		function check(mode: (typeof modes)[number], value: string | undefined) {
			const request = completeRequest();
			const message = fromWire(encodeBindleDeploymentRequest(request));
			if (!message.yard) throw new Error("missing Yard");
			const { requestedYardId: _id, ...existingYard } = request.yard;
			const yard = {
				...existingYard,
				selectionMode: mode,
				...(value === undefined ? undefined : { requestedYardId: value }),
			};
			message.yard.selectionMode = mode;
			message.yard.requestedYardId = value;
			message.requestDigest = contentHashOf({ ...request, yard });
			let parserAccepted = true;
			try {
				parseBindleDeploymentRequest(cloneAsJson({ ...request, yard }));
			} catch {
				parserAccepted = false;
			}
			const encoded = JSON.stringify(
				toJson(BindleDeploymentRequestSchema, message, {
					alwaysEmitImplicit: true,
					useProtoFieldName: true,
				}),
			).replaceAll("\ufeff", "\\ufeff");
			const result = vet(encoded);
			expect(result.error).toBeUndefined();
			expect(
				result.status === 0,
				`${mode} ${JSON.stringify(value)}: ${result.stderr}`,
			).toBe(parserAccepted);
		}
		for (const mode of modes) {
			for (const value of [
				undefined,
				"",
				...whitespace,
				"\u0085",
				"\u180e",
				"\ufeffyard",
				" yard:one ",
			])
				check(mode, value);
		}
		fc.assert(
			fc.property(
				fc.constantFrom(...modes),
				fc.array(fc.constantFrom(...whitespace), { maxLength: 5 }),
				fc.boolean(),
				(mode, characters, addText) =>
					check(mode, `${characters.join("")}${addText ? "y" : ""}`),
			),
			{ seed: 614_591, numRuns: 40 },
		);
		fc.assert(fc.property(fc.constantFrom(...modes), fc.string(), check), {
			seed: 614_592,
			numRuns: 80,
		});
	}, 45_000);

	it("agrees with Camp parser nonblank rules across Unicode and generated inputs", () => {
		const whitespace = [
			...Array.from({ length: 5 }, (_, index) =>
				String.fromCodePoint(9 + index),
			),
			" ",
			"\u00a0",
			"\u1680",
			...Array.from({ length: 11 }, (_, index) =>
				String.fromCodePoint(0x2000 + index),
			),
			"\u2028",
			"\u2029",
			"\u202f",
			"\u205f",
			"\u3000",
			"\ufeff",
		];
		const fields = [
			"campId",
			"envType",
			"require",
			"prefer",
			"runtimeRequirements",
		] as const;
		function check(field: (typeof fields)[number], value: string) {
			const request = completeRequest();
			const message = fromWire(encodeBindleDeploymentRequest(request));
			if (!request.camp || !message.camp?.layout)
				throw new Error("missing Camp");
			const camp =
				field === "campId"
					? { ...request.camp, campId: value }
					: {
							...request.camp,
							layout: {
								...request.camp.layout,
								[field]: field === "envType" ? value : [value],
							},
						};
			if (field === "campId") message.camp.campId = value;
			else if (field === "envType") message.camp.layout.envType = value;
			else if (field === "require") message.camp.layout.require = [value];
			else if (field === "prefer") message.camp.layout.prefer = [value];
			else message.camp.layout.runtimeRequirements = [value];
			message.requestDigest = contentHashOf({ ...request, camp });
			let parserAccepted = true;
			try {
				parseBindleDeploymentRequest(cloneAsJson({ ...request, camp }));
			} catch {
				parserAccepted = false;
			}
			const encoded = JSON.stringify(
				toJson(BindleDeploymentRequestSchema, message, {
					alwaysEmitImplicit: true,
					useProtoFieldName: true,
				}),
			).replaceAll("\ufeff", "\\ufeff");
			const result = vet(encoded);
			expect(result.error).toBeUndefined();
			expect(
				result.status === 0,
				`${field} ${JSON.stringify(value)}: ${result.stderr}`,
			).toBe(parserAccepted);
		}
		for (const field of fields) {
			for (const value of ["", ...whitespace, "\u0085", "\u180e", " a ", "a/b"])
				check(field, value);
		}
		fc.assert(
			fc.property(
				fc.constantFrom(...fields),
				fc.array(fc.constantFrom(...whitespace), { maxLength: 5 }),
				fc.boolean(),
				(field, characters, addText) =>
					check(field, `${characters.join("")}${addText ? "a" : ""}`),
			),
			{ seed: 614_587, numRuns: 40 },
		);
		fc.assert(fc.property(fc.constantFrom(...fields), fc.string(), check), {
			seed: 614_588,
			numRuns: 80,
		});
	}, 30_000);
	it.each([
		["missing properties", missingPropertiesDocument],
		["missing estimate", document.replace('"spend_estimate_usd":3.25,', "")],
		["bad digest", document.replace(/sha256:[0-9a-f]{64}(?="})/, "sha256:bad")],
	])("refuses a %s", (_description, input) => {
		expect(input).not.toBe(document);
		const result = vet(input);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
	});
});
