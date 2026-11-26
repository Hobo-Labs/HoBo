import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

const PIN_ID_RE =
	/^(?<namespace>[a-z0-9-]+):(?<packageName>[a-z0-9-]+)\/(?<interfaceName>[a-z0-9-]+)@(?<version>[0-9]+\.[0-9]+\.[0-9]+)@(?<stability>stable|preview|experimental|deprecated)$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const PACKAGE_RE = /^\s*package\s+([\w-]+:[\w-]+)(?:@([\w.+-]+))?\s*;/m;
const INTERFACE_RE = /^\s*interface\s+([\w-]+)\s*\{([\s\S]*?)^\s*\}/gm;
const WORLD_RE = /^\s*world\s+([\w-]+)\s*\{([\s\S]*?)^\s*\}/m;
const IMPORT_EXPORT_RE = /^\s*(import|export)\s+([^;]+)\s*;/gm;
const FUNC_RE =
	/^\s*([\w-]+):\s*(async\s+)?func\s*\(([^)]*)\)\s*(?:->\s*([^;]+))?;/gm;

export const HOBO_WIT_PACKAGE = "@hobo/wit";

export type StabilityTier =
	| "stable"
	| "preview"
	| "experimental"
	| "deprecated";

export type InterfacePin = Readonly<{
	id: string;
	namespace: string;
	packageName: string;
	interfaceName: string;
	version: string;
	stability: StabilityTier;
	path: string;
	sha256: string;
}>;

export type GeneratorPin = Readonly<{
	name: string;
	version: string;
	role: string;
}>;

export type CompatFloor = Readonly<{
	wasmtime: string;
	componentizeJs: string;
	wrpc: string;
	wasmCloud: string;
	defaultTransport: string;
}>;

export type ToolchainLock = Readonly<{
	schema: "hobo.wit-toolchain-lock/v1";
	package: "hobo:sdk@0.1.0";
	canonicalGenerator: GeneratorPin;
	smokeGenerators: readonly GeneratorPin[];
	compatFloor: CompatFloor;
	witDeps: readonly InterfacePin[];
	guards: readonly string[];
}>;

export type FunctionSignature = Readonly<{
	name: string;
	async: boolean;
	params: readonly { name: string; type: string }[];
	result: string;
}>;

export type InterfaceSignatures = Readonly<{
	name: string;
	functions: readonly FunctionSignature[];
}>;

export type ComponentSurface = Readonly<{
	package: string;
	version: string | null;
	world: string;
	imports: readonly string[];
	exports: readonly string[];
	functionSignatures: readonly InterfaceSignatures[];
	surfaceDigest: string;
}>;

export type SurfaceParityReport = Readonly<{
	parity: "matched" | "drifted";
	driftedImports: readonly string[];
	driftedExports: readonly string[];
	driftedSignatures: readonly string[];
}>;

export type VendorVerification = Readonly<{
	schema: "hobo.wit.vendor-verification/v1";
	verified: number;
	pins: readonly InterfacePin[];
}>;

export type ComponentImportsExports = Readonly<{
	artifact?: string;
	imports: readonly string[];
	exports: readonly string[];
}>;

export class WitDigestMismatchError extends Error {
	readonly code = "wit.digest_mismatch" as const;
	readonly pinId: string;
	readonly expectedSha256: string;
	readonly actualSha256: string;

	constructor(pinId: string, expectedSha256: string, actualSha256: string) {
		super(
			`wit.digest_mismatch: pin ${pinId} expected ${expectedSha256}, got ${actualSha256}`,
		);
		this.name = "WitDigestMismatchError";
		this.pinId = pinId;
		this.expectedSha256 = expectedSha256;
		this.actualSha256 = actualSha256;
	}
}

export const EXPECTED_ROUND_TRIP_INTERFACES = Object.freeze([
	"wasi:keyvalue/store@0.2.0",
	"wasi:blobstore/blobstore@0.2.0",
	"wasi:config/store@0.2.0",
	"wasi:logging/logging@0.2.0",
]);

const ROUND_TRIP_FIXTURES = new Map<string, JsonObject>([
	[
		"wasi:keyvalue/store@0.2.0",
		{ key: "tenant-a/user-1", value: [115, 101, 115, 115, 105, 111, 110] },
	],
	[
		"wasi:blobstore/blobstore@0.2.0",
		{
			name: "avatars/user-1.png",
			"content-type": "image/png",
			digest:
				"sha256:9a3c0a8a4ce0ce91d8ff1d357f179aef9f1e4a46358b82b223be99f6e6f9f1e1",
			size: 128,
		},
	],
	[
		"wasi:config/store@0.2.0",
		{
			key: "STRIPE_API_KEY",
			"value-ref": "stripe/api-key",
			sensitivity: "secret",
		},
	],
	[
		"wasi:logging/logging@0.2.0",
		{
			level: "info",
			message: "resource linked",
			fields: [
				{ key: "resource", value: "kv.sessions" },
				{ key: "interface", value: "wasi:keyvalue/store@0.2.0" },
			],
		},
	],
]);

const ROUND_TRIP_WIT_SNIPPETS = new Map<string, readonly string[]>([
	["wasi:keyvalue/store@0.2.0", ["key: string", "value: list<u8>"]],
	[
		"wasi:blobstore/blobstore@0.2.0",
		["content-type: string", "digest: string", "size: u64"],
	],
	["wasi:config/store@0.2.0", ["value-ref: string", "sensitivity: string"]],
	["wasi:logging/logging@0.2.0", ["fields: list<field>"]],
]);

export function parseInterfacePin(raw: string): InterfacePin {
	if (!isJsonString(raw) || raw.length === 0) {
		throw new Error("wit.pin.invalid: empty pin id");
	}

	const match = PIN_ID_RE.exec(raw);
	if (!match?.groups) {
		throw new Error(`wit.pin.invalid: malformed pin id ${raw}`);
	}

	const { namespace, packageName, interfaceName, version, stability } =
		match.groups;
	if (
		!namespace ||
		!packageName ||
		!interfaceName ||
		!version ||
		(stability !== "stable" &&
			stability !== "preview" &&
			stability !== "experimental" &&
			stability !== "deprecated")
	) {
		throw new Error(`wit.pin.invalid: malformed pin id ${raw}`);
	}

	return Object.freeze({
		id: raw,
		namespace,
		packageName,
		interfaceName,
		version,
		stability,
		path: "",
		sha256: "",
	});
}

export async function loadToolchainLock(path: string): Promise<ToolchainLock> {
	const raw = parseJsonValue(await readFile(path, "utf8"));
	return parseToolchainLock(raw);
}

export function parseToolchainLock<T>(raw: T): ToolchainLock {
	if (!isJsonObject(raw)) {
		throw new Error("wit.lock.invalid: lock must be an object");
	}
	if (raw.schema !== "hobo.wit-toolchain-lock/v1") {
		throw new Error(
			"wit.lock.invalid: schema must be hobo.wit-toolchain-lock/v1",
		);
	}
	if (raw.package !== "hobo:sdk@0.1.0") {
		throw new Error("wit.lock.invalid: package must be hobo:sdk@0.1.0");
	}

	const canonicalGenerator = parseGeneratorPin(
		raw.canonical_generator ?? raw.canonicalGenerator,
		"canonical_generator",
	);
	if (canonicalGenerator.name !== "@bytecodealliance/jco") {
		throw new Error(
			"wit.lock.invalid: canonical generator must be @bytecodealliance/jco",
		);
	}

	const smokeSource = raw.smoke_generators ?? raw.smokeGenerators;
	const smokeGenerators = Array.isArray(smokeSource)
		? smokeSource.map((entry: JsonValue, index: number) =>
				parseGeneratorPin(entry, `smoke_generators[${index}]`),
			)
		: [];

	const compatFloor = parseCompatFloor(raw.compat_floor ?? raw.compatFloor);
	const witDepsSource = raw.wit_deps ?? raw.witDeps;
	const witDeps = Array.isArray(witDepsSource)
		? witDepsSource.map((entry: JsonValue, index: number) =>
				parseInterfacePinRecord(entry, index),
			)
		: [];

	const guards = Array.isArray(raw.guards)
		? raw.guards.map((guard) => {
				if (!isJsonString(guard) || guard.length === 0) {
					throw new Error("wit.lock.invalid: guard must be non-empty string");
				}
				return guard;
			})
		: [];

	return Object.freeze({
		schema: "hobo.wit-toolchain-lock/v1",
		package: "hobo:sdk@0.1.0",
		canonicalGenerator,
		smokeGenerators,
		compatFloor,
		witDeps,
		guards,
	});
}

export async function verifyVendoredWit(
	lock: ToolchainLock,
	rootDir: string,
): Promise<VendorVerification> {
	const verifiedPins: InterfacePin[] = [];

	for (const pin of lock.witDeps) {
		const filePath = join(rootDir, pin.path);
		const source = await readFile(filePath, "utf8");
		assertVendoredWitSurface(pin, source);

		const actualSha256 = digestSource(source);
		if (actualSha256 !== pin.sha256) {
			throw new WitDigestMismatchError(pin.id, pin.sha256, actualSha256);
		}

		verifiedPins.push(
			Object.freeze({
				...pin,
				sha256: actualSha256,
			}),
		);
	}

	return Object.freeze({
		schema: "hobo.wit.vendor-verification/v1",
		verified: verifiedPins.length,
		pins: verifiedPins,
	});
}

export function extractWitContract(witSource: string) {
	const packageMatch = witSource.match(PACKAGE_RE);
	if (!packageMatch?.[1]) {
		throw new Error("wit.surface.missing_package");
	}

	const interfaces: Record<
		string,
		{ name: string; functions: FunctionSignature[] }
	> = {};
	for (const match of witSource.matchAll(INTERFACE_RE)) {
		const name = match[1];
		const body = match[2];
		if (!name || body === undefined) {
			continue;
		}
		const functions: FunctionSignature[] = [];

		for (const functionMatch of body.matchAll(FUNC_RE)) {
			const fnName = functionMatch[1];
			if (!fnName) {
				continue;
			}
			functions.push({
				name: fnName,
				async: functionMatch[2] !== undefined,
				params: parseParams(functionMatch[3] ?? ""),
				result: normalizeType(functionMatch[4] ?? "_"),
			});
		}

		interfaces[name] = { name, functions };
	}

	const worldMatch = witSource.match(WORLD_RE);
	if (!worldMatch?.[1] || worldMatch[2] === undefined) {
		throw new Error("wit.surface.missing_world");
	}

	return normalizeContract({
		package: packageMatch[1],
		version: packageMatch[2] ?? null,
		world: worldMatch[1],
		interfaces,
		...parseWorldEntries(worldMatch[2]),
	});
}

export function extractComponentSurface(
	artifact: ComponentImportsExports,
	declaredContract?: ReturnType<typeof extractWitContract>,
): ComponentSurface {
	const contract = declaredContract ?? {
		package: "hobo:sdk",
		version: "0.1.0",
		world: "sdk",
		interfaces: {},
		imports: [...artifact.imports],
		exports: [...artifact.exports],
	};

	const manifest = buildComponentManifest(contract, artifact);
	return toComponentSurface(manifest);
}

export function compareSurfaces(
	forward: ComponentSurface,
	reverse: ComponentSurface,
): SurfaceParityReport {
	const importDrift = compareInterfaceLists(forward.imports, reverse.imports);
	const exportDrift = compareInterfaceLists(forward.exports, reverse.exports);
	const signatureDrift = compareImportedSignatures(forward, reverse);
	const driftedImports = [...importDrift.missing, ...importDrift.extra];
	const driftedExports = [...exportDrift.missing, ...exportDrift.extra];
	const driftedSignatures = signatureDrift.map((entry) => entry.interface);
	const matched =
		driftedImports.length === 0 &&
		driftedExports.length === 0 &&
		driftedSignatures.length === 0;

	return Object.freeze({
		parity: matched ? "matched" : "drifted",
		driftedImports,
		driftedExports,
		driftedSignatures,
	});
}

export function buildComponentManifest(
	contract: ReturnType<typeof extractWitContract>,
	overrides: Partial<ComponentImportsExports> = {},
) {
	const normalized = normalizeContract(contract);
	return normalizeContract({
		...normalized,
		imports: overrides.imports ?? normalized.imports,
		exports: overrides.exports ?? normalized.exports,
	});
}

export function compareForwardReverse(
	declaredContract: ReturnType<typeof extractWitContract>,
	extractedManifest: ReturnType<typeof extractWitContract>,
) {
	const declared = normalizeContract(declaredContract);
	const extracted = normalizeContract(extractedManifest);
	const forward = toComponentSurface(declared);
	const reverse = toComponentSurface(extracted);
	const report = compareSurfaces(forward, reverse);

	return {
		ok: report.parity === "matched",
		declared: surfaceDigest(declared),
		extracted: surfaceDigest(extracted),
		imports: compareInterfaceLists(declared.imports, extracted.imports),
		exports: compareInterfaceLists(declared.exports, extracted.exports),
		signatureDrift: compareSignatureRecords(forward, reverse),
		report,
	};
}

export async function roundTripFixture(
	interfaceRef: string,
	lock: ToolchainLock,
	rootDir: string,
) {
	await verifyVendoredWit(lock, rootDir);

	if (!ROUND_TRIP_FIXTURES.has(interfaceRef)) {
		throw new Error(`wasi_roundtrip.unlinked_interface: ${interfaceRef}`);
	}

	const fixture = ROUND_TRIP_FIXTURES.get(interfaceRef);
	if (fixture === undefined) {
		throw new Error(`wasi_roundtrip.missing_fixture: ${interfaceRef}`);
	}
	const input = structuredClone(fixture);
	assertRoundTripFixture(interfaceRef, input);
	const encoded = canonicalJson(input);
	const decoded = parseJsonValue(encoded);

	return {
		interfaceRef,
		input,
		encoded,
		decoded,
	};
}

export function digestSource(source: string): string {
	return `sha256:${createHash("sha256").update(source.replace(/\r\n/g, "\n"), "utf8").digest("hex")}`;
}

function parseGeneratorPin(
	raw: JsonValue | undefined,
	label: string,
): GeneratorPin {
	if (!isJsonObject(raw)) {
		throw new Error(`wit.lock.invalid: ${label} must be an object`);
	}

	const entry = raw;
	if (!isJsonString(entry.name) || entry.name.length === 0) {
		throw new Error(`wit.lock.invalid: ${label}.name required`);
	}
	if (
		!isJsonString(entry.version) ||
		!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(entry.version)
	) {
		throw new Error(`wit.lock.invalid: ${label}.version must be exact semver`);
	}
	if (!isJsonString(entry.role) || entry.role.length === 0) {
		throw new Error(`wit.lock.invalid: ${label}.role required`);
	}

	return Object.freeze({
		name: entry.name,
		version: entry.version,
		role: entry.role,
	});
}

function parseCompatFloor(raw: JsonValue | undefined): CompatFloor {
	if (!isJsonObject(raw)) {
		throw new Error("wit.lock.invalid: compat_floor required");
	}

	const floor = raw;
	const wasmtime = readExactVersion(floor, "wasmtime");
	const componentizeJs = readExactVersion(
		floor,
		"componentize_js",
		"componentizeJs",
	);
	const wrpc = readExactVersion(floor, "wrpc");
	const wasmCloud = readExactVersion(floor, "wasm_cloud", "wasmCloud");
	const defaultTransport = isJsonString(floor.default_transport)
		? floor.default_transport
		: isJsonString(floor.defaultTransport)
			? floor.defaultTransport
			: "wrpc@0.17.0+nats";

	return Object.freeze({
		wasmtime,
		componentizeJs,
		wrpc,
		wasmCloud,
		defaultTransport,
	});
}

function parseInterfacePinRecord(
	raw: JsonValue | undefined,
	index: number,
): InterfacePin {
	if (!isJsonObject(raw)) {
		throw new Error(`wit.lock.invalid: wit_deps[${index}] must be an object`);
	}

	const entry = raw;
	const id = isJsonString(entry.id)
		? entry.id
		: isJsonString(entry.interface)
			? `${entry.interface}@${entry.stability ?? "preview"}`
			: "";

	const parsed = parseInterfacePin(id);
	const path = isJsonString(entry.path) ? entry.path : "";
	const sha256 = isJsonString(entry.sha256)
		? entry.sha256
		: String(entry.digest ?? "");

	if (!path.startsWith("wit/") || !path.endsWith(".wit")) {
		throw new Error(
			`wit.lock.invalid: wit_deps[${index}].path must be wit/**/*.wit`,
		);
	}
	if (!SHA256_RE.test(sha256)) {
		throw new Error(
			`wit.lock.invalid: wit_deps[${index}].sha256 must match sha256:<hex>`,
		);
	}

	return Object.freeze({
		...parsed,
		path,
		sha256,
	});
}

function readExactVersion(floor: JsonObject, ...keys: string[]): string {
	for (const key of keys) {
		const value = floor[key];
		if (isJsonString(value) && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value)) {
			return value;
		}
	}
	throw new Error(
		`wit.lock.invalid: compat floor missing exact version for ${keys[0]}`,
	);
}

function assertVendoredWitSurface(pin: InterfacePin, source: string) {
	const packageDecl = `package ${pin.namespace}:${pin.packageName}@${pin.version};`;
	const surfaceDecl =
		pin.path === "wit/hobo-sdk.wit"
			? `world ${pin.interfaceName}`
			: `interface ${pin.interfaceName}`;

	if (!source.includes(packageDecl) || !source.includes(surfaceDecl)) {
		throw new Error(`wasi_pin.invalid_wit_surface: ${pin.id}`);
	}

	const interfaceRef = `${pin.namespace}:${pin.packageName}/${pin.interfaceName}@${pin.version}`;
	for (const snippet of ROUND_TRIP_WIT_SNIPPETS.get(interfaceRef) ?? []) {
		if (!source.includes(snippet)) {
			throw new Error(`wasi_pin.roundtrip_shape_drift: ${pin.id}`);
		}
	}
}

function toComponentSurface(
	contract: ReturnType<typeof normalizeContract>,
): ComponentSurface {
	const digest = surfaceDigest(contract);
	return Object.freeze({
		package: contract.package,
		version: contract.version,
		world: contract.world,
		imports: contract.imports,
		exports: contract.exports,
		functionSignatures: Object.values(contract.interfaces).map((iface) =>
			Object.freeze({
				name: iface.name,
				functions: iface.functions,
			}),
		),
		surfaceDigest: digest.sha256,
	});
}

function compareSignatureRecords(
	forward: ComponentSurface,
	reverse: ComponentSurface,
) {
	const drift: { interface: string; reason: string }[] = [];
	for (const name of forward.imports.filter((importName) =>
		reverse.imports.includes(importName),
	)) {
		const declared = forward.functionSignatures.find(
			(entry) => entry.name === name,
		);
		const extracted = reverse.functionSignatures.find(
			(entry) => entry.name === name,
		);
		if (!declared && !extracted) {
			continue;
		}
		if (!extracted) {
			drift.push({ interface: name, reason: "missing extracted interface" });
			continue;
		}
		if (
			JSON.stringify(declared?.functions) !==
			JSON.stringify(extracted.functions)
		) {
			drift.push({ interface: name, reason: "function signatures differ" });
		}
	}
	return drift;
}

function compareImportedSignatures(
	forward: ComponentSurface,
	reverse: ComponentSurface,
) {
	return compareSignatureRecords(forward, reverse);
}

function parseWorldEntries(worldBody: string) {
	const imports: string[] = [];
	const exports: string[] = [];

	for (const match of worldBody.matchAll(IMPORT_EXPORT_RE)) {
		const direction = match[1];
		const name = match[2];
		if (!direction || !name) {
			continue;
		}
		if (direction === "import") {
			imports.push(name.trim());
		} else {
			exports.push(name.trim());
		}
	}

	return { imports, exports };
}

function parseParams(params: string) {
	const trimmed = params.trim();
	if (!trimmed) {
		return [];
	}

	return trimmed.split(",").map((param) => {
		const [name, ...typeParts] = param.trim().split(":");
		if (!name) {
			throw new Error("wit.surface.invalid_param");
		}
		return {
			name: name.trim(),
			type: normalizeType(typeParts.join(":")),
		};
	});
}

function compareInterfaceLists(
	declared: readonly string[],
	extracted: readonly string[],
) {
	return {
		missing: declared.filter((name) => !extracted.includes(name)),
		extra: extracted.filter((name) => !declared.includes(name)),
	};
}

function normalizeContract(contract: {
	package: string;
	version: string | null;
	world: string;
	interfaces: Record<string, { name: string; functions: FunctionSignature[] }>;
	imports: readonly string[];
	exports: readonly string[];
}) {
	return {
		package: contract.package,
		version: contract.version ?? null,
		world: contract.world,
		interfaces: normalizeInterfaces(contract.interfaces),
		imports: uniqueSorted(contract.imports),
		exports: uniqueSorted(contract.exports),
	};
}

function normalizeInterfaces(
	interfaces: Record<string, { name: string; functions: FunctionSignature[] }>,
) {
	const normalized: Record<
		string,
		{ name: string; functions: FunctionSignature[] }
	> = {};
	for (const [name, details] of Object.entries(interfaces)) {
		normalized[name] = {
			name,
			functions: [...details.functions]
				.map((fn) => ({
					name: fn.name,
					async: fn.async,
					params: fn.params.map((param) => ({
						name: param.name,
						type: normalizeType(param.type),
					})),
					result: normalizeType(fn.result),
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
		};
	}

	return Object.fromEntries(
		Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)),
	);
}

function surfaceDigest(contract: ReturnType<typeof normalizeContract>) {
	return {
		package: contract.package,
		version: contract.version,
		world: contract.world,
		imports: contract.imports,
		exports: contract.exports,
		interfaces: contract.interfaces,
		sha256: createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
	};
}

function normalizeType(type: string): string {
	return type.replace(/\s+/g, " ").trim();
}

function uniqueSorted(values: readonly string[]) {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function canonicalJson(value: JsonValue): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}

	if (isJsonObject(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, canonicalize(nested)]),
		);
	}

	return value;
}

function assertRoundTripFixture(interfaceRef: string, value: JsonObject) {
	const validators = new Map<string, () => void>([
		[
			"wasi:keyvalue/store@0.2.0",
			() => {
				assertString(value.key, "keyvalue.key");
				assertByteList(value.value, "keyvalue.value");
			},
		],
		[
			"wasi:blobstore/blobstore@0.2.0",
			() => {
				assertString(value.name, "blobstore.name");
				assertString(value["content-type"], "blobstore.content-type");
				assertString(value.digest, "blobstore.digest");
				assertInteger(value.size, "blobstore.size");
			},
		],
		[
			"wasi:config/store@0.2.0",
			() => {
				assertString(value.key, "config.key");
				assertString(value["value-ref"], "config.value-ref");
				assertString(value.sensitivity, "config.sensitivity");
			},
		],
		[
			"wasi:logging/logging@0.2.0",
			() => {
				assertString(value.level, "logging.level");
				assertString(value.message, "logging.message");
				if (!Array.isArray(value.fields)) {
					throw new Error("wasi_roundtrip.invalid_shape: logging.fields");
				}
				for (const field of value.fields) {
					if (!isJsonObject(field)) {
						throw new Error("wasi_roundtrip.invalid_shape: logging.field");
					}
					assertString(field.key, "logging.field.key");
					assertString(field.value, "logging.field.value");
				}
			},
		],
	]);

	const validator = validators.get(interfaceRef);
	if (!validator) {
		throw new Error(`wasi_roundtrip.unlinked_interface: ${interfaceRef}`);
	}
	validator();
}

function assertString(value: JsonValue | undefined, field: string) {
	if (!isJsonString(value) || value.length === 0) {
		throw new Error(`wasi_roundtrip.invalid_shape: ${field}`);
	}
}

function assertInteger(value: JsonValue | undefined, field: string) {
	if (!isJsonNumber(value) || !Number.isInteger(value) || value < 0) {
		throw new Error(`wasi_roundtrip.invalid_shape: ${field}`);
	}
}

function assertByteList(value: JsonValue | undefined, field: string) {
	if (
		!Array.isArray(value) ||
		value.some(
			(item) =>
				!isJsonNumber(item) ||
				!Number.isInteger(item) ||
				item < 0 ||
				item > 255,
		)
	) {
		throw new Error(`wasi_roundtrip.invalid_shape: ${field}`);
	}
}

export const PACKAGE_ROOT = new URL("..", import.meta.url).pathname;

export function resolvePackagePath(...segments: string[]): string {
	return join(PACKAGE_ROOT, ...segments);
}

export function interfaceRefFromPin(pin: InterfacePin): string {
	return `${pin.namespace}:${pin.packageName}/${pin.interfaceName}@${pin.version}`;
}

export function vendorFileName(pin: InterfacePin): string {
	return basename(pin.path);
}

export type * as HoboSdk from "./generated/sdk/sdk.js";
export {
	assertGeneratedMatches,
	WIT_ROOT,
	writeGeneratedBindings,
} from "./wit-gen.js";
