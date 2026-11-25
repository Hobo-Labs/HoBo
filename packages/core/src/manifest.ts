import { ManifestParseError } from "./errors.js";
import type { JsonObject, JsonValue } from "./json.js";
import {
	assertNoExtra,
	cloneJson,
	currency,
	deepFreeze,
	enumValue,
	expectObject,
	headerName,
	httpsUrl,
	nonEmptyString,
	positiveInteger,
	requiredArray,
	sha256Ref,
	uniqueStringArray,
} from "./parse-utils.js";
import type { InterfaceStability } from "./ports.js";

// public-contract: the core manifest schema version consumers pin against.
export const CORE_SCHEMA_VERSION = "hobo.core/v1";

const STABILITIES = new Set<InterfaceStability>([
	"stable",
	"preview",
	"experimental",
]);
const FLOW_ORDER = [
	"oidc-federation",
	"oauth2-xaa",
	"oauth2-obo",
	"device-code",
	"api-key",
] as const;
type AuthFlowType = (typeof FLOW_ORDER)[number];
const FLOW_ORDER_SET = new Set<AuthFlowType>(FLOW_ORDER);
const REQUIRED_MANIFEST_FILES = [
	"capabilities.json",
	"auth.json",
	"cost.json",
] as const;

// domain-view: parse-don't-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface CapabilityManifestBundle {
	index: {
		schemaVersion: "hobo.core/v1";
		issuer: string;
		manifestDigest: string;
		signature: {
			alg: "HOBO-FIXTURE-SHA256";
			keyId: string;
			digest: string;
		};
		files: string[];
	};
	capabilities: {
		ports: Array<{
			port: string;
			kinds: string[];
			stability: InterfaceStability;
		}>;
		regions: string[];
		equivalenceClasses: string[];
	};
	auth: {
		issuer: string;
		flows: Array<JsonObject>;
		scopeModel: "least-privilege-per-resource";
		resourceIndicators: string[];
		tokenLifetimeSec: number;
		audit: { events: string[] };
	};
	cost: {
		currency: string;
		unitPrices: Record<
			string,
			{ unit: string; amount: number; regions?: string[] }
		>;
		freeTier: unknown[];
	};
}

export interface ParseCapabilityManifestOptions {
	trustedIssuer?: string;
	trustedOidcDiscoveryHost?: string;
}

export function parseCapabilityManifestBundle(
	input: JsonValue | undefined,
	options: ParseCapabilityManifestOptions = {},
): CapabilityManifestBundle {
	const source = expectObject(
		input,
		"capability manifest bundle",
		ManifestParseError,
	);
	const index = parseIndex(source.index, options);
	const capabilities = parseCapabilities(source.capabilities);
	const auth = parseAuth(source.auth, index, options);
	const cost = parseCost(source.cost);

	return deepFreeze({ index, capabilities, auth, cost });
}

function parseIndex(
	input: JsonValue | undefined,
	options: ParseCapabilityManifestOptions,
): CapabilityManifestBundle["index"] {
	const source = expectObject(input, "index.json", ManifestParseError);
	assertNoExtra(
		source,
		"index.json",
		["schemaVersion", "issuer", "manifestDigest", "signature", "files"],
		ManifestParseError,
	);
	if (source.schemaVersion !== CORE_SCHEMA_VERSION) {
		throw new ManifestParseError(
			"index.schemaVersion",
			CORE_SCHEMA_VERSION,
			source.schemaVersion,
		);
	}
	const issuer = httpsUrl(source.issuer, "index.issuer", ManifestParseError);
	if (
		options.trustedIssuer &&
		issuer !==
			httpsUrl(options.trustedIssuer, "trustedIssuer", ManifestParseError)
	) {
		throw new ManifestParseError(
			"index.issuer",
			"trusted issuer match",
			source.issuer,
		);
	}
	const files = uniqueStringArray(
		source.files,
		"index.files",
		ManifestParseError,
	);
	for (const required of REQUIRED_MANIFEST_FILES) {
		if (!files.includes(required)) {
			throw new ManifestParseError(
				"index.files",
				`includes ${required}`,
				source.files,
			);
		}
	}
	const signature = expectObject(
		source.signature,
		"index.signature",
		ManifestParseError,
	);
	assertNoExtra(
		signature,
		"index.signature",
		["alg", "keyId", "digest"],
		ManifestParseError,
	);
	if (signature.alg !== "HOBO-FIXTURE-SHA256") {
		throw new ManifestParseError(
			"index.signature.alg",
			"HOBO-FIXTURE-SHA256",
			signature.alg,
		);
	}
	return {
		schemaVersion: CORE_SCHEMA_VERSION,
		issuer,
		manifestDigest: sha256Ref(
			source.manifestDigest,
			"index.manifestDigest",
			ManifestParseError,
		),
		signature: {
			alg: "HOBO-FIXTURE-SHA256",
			keyId: nonEmptyString(
				signature.keyId,
				"index.signature.keyId",
				ManifestParseError,
			),
			digest: sha256Ref(
				signature.digest,
				"index.signature.digest",
				ManifestParseError,
			),
		},
		files,
	};
}

function parseCapabilities(
	input: JsonValue | undefined,
): CapabilityManifestBundle["capabilities"] {
	const source = expectObject(input, "capabilities.json", ManifestParseError);
	assertNoExtra(
		source,
		"capabilities.json",
		["ports", "regions", "equivalenceClasses"],
		ManifestParseError,
	);
	const seenPorts = new Set<string>();
	const ports = requiredArray(
		source.ports,
		"capabilities.ports",
		ManifestParseError,
	).map((entry, index) => {
		const field = `capabilities.ports[${index}]`;
		const port = expectObject(entry, field, ManifestParseError);
		assertNoExtra(
			port,
			field,
			["port", "kinds", "stability"],
			ManifestParseError,
		);
		const name = nonEmptyString(port.port, `${field}.port`, ManifestParseError);
		if (seenPorts.has(name)) {
			throw new ManifestParseError(field, "unique port name", name);
		}
		seenPorts.add(name);
		return {
			port: name,
			kinds: uniqueStringArray(
				port.kinds,
				`${field}.kinds`,
				ManifestParseError,
				{ minLength: 1 },
			),
			stability: enumValue(
				port.stability,
				STABILITIES,
				`${field}.stability`,
				ManifestParseError,
			),
		};
	});

	return {
		ports,
		regions: uniqueStringArray(
			source.regions,
			"capabilities.regions",
			ManifestParseError,
			{ minLength: 1 },
		),
		equivalenceClasses: uniqueStringArray(
			source.equivalenceClasses ?? [],
			"capabilities.equivalenceClasses",
			ManifestParseError,
		),
	};
}

function parseAuth(
	input: JsonValue | undefined,
	index: CapabilityManifestBundle["index"],
	options: ParseCapabilityManifestOptions,
): CapabilityManifestBundle["auth"] {
	const source = expectObject(input, "auth.json", ManifestParseError);
	assertNoExtra(
		source,
		"auth.json",
		[
			"issuer",
			"flows",
			"scopeModel",
			"resourceIndicators",
			"tokenLifetimeSec",
			"audit",
		],
		ManifestParseError,
	);
	const issuer = httpsUrl(source.issuer, "auth.issuer", ManifestParseError);
	if (issuer !== index.issuer) {
		throw new ManifestParseError(
			"auth.issuer",
			"match index.issuer",
			source.issuer,
		);
	}
	const flows = parseFlows(source.flows, options);
	const audit = expectObject(source.audit, "auth.audit", ManifestParseError);
	return {
		issuer,
		flows,
		scopeModel: enumValue(
			source.scopeModel,
			new Set(["least-privilege-per-resource"] as const),
			"auth.scopeModel",
			ManifestParseError,
		),
		resourceIndicators: parseResourceIndicators(source.resourceIndicators),
		tokenLifetimeSec: positiveInteger(
			source.tokenLifetimeSec,
			"auth.tokenLifetimeSec",
			ManifestParseError,
			{
				max: 86_400,
			},
		),
		audit: {
			events: uniqueStringArray(
				audit.events,
				"auth.audit.events",
				ManifestParseError,
				{ minLength: 1 },
			),
		},
	};
}

function parseFlows(
	input: JsonValue | undefined,
	options: ParseCapabilityManifestOptions,
): Array<JsonObject> {
	const flows = requiredArray(input, "auth.flows", ManifestParseError).map(
		(flow, index) => parseFlow(flow, index, options),
	);
	const seen = new Set<string>();
	for (const flow of flows) {
		// SAFETY: assertion required at this I/O or test boundary.
		const type = flow.type as string;
		if (seen.has(type)) {
			throw new ManifestParseError("auth.flows", "unique flow type", type);
		}
		seen.add(type);
	}
	return flows.sort(
		(a, b) =>
			// SAFETY: assertion required at this I/O or test boundary.
			FLOW_ORDER.indexOf(a.type as AuthFlowType) -
			// SAFETY: assertion required at this I/O or test boundary.
			FLOW_ORDER.indexOf(b.type as AuthFlowType),
	);
}

function parseFlow(
	input: JsonValue | undefined,
	index: number,
	options: ParseCapabilityManifestOptions,
): JsonObject {
	const source = expectObject(
		input,
		`auth.flows[${index}]`,
		ManifestParseError,
	);
	const type = enumValue(
		source.type,
		FLOW_ORDER_SET,
		`auth.flows[${index}].type`,
		ManifestParseError,
	);
	if (type === "oidc-federation") {
		assertNoExtra(
			source,
			`auth.flows[${index}]`,
			["type", "audience", "exchange", "trust"],
			ManifestParseError,
		);
		const trust = expectObject(
			source.trust,
			`auth.flows[${index}].trust`,
			ManifestParseError,
		);
		const oidcDiscovery = httpsUrl(
			trust.oidcDiscovery,
			`auth.flows[${index}].trust.oidcDiscovery`,
			ManifestParseError,
		);
		if (
			options.trustedOidcDiscoveryHost &&
			new URL(oidcDiscovery).hostname !== options.trustedOidcDiscoveryHost
		) {
			throw new ManifestParseError(
				`auth.flows[${index}].trust.oidcDiscovery`,
				`host ${options.trustedOidcDiscoveryHost}`,
				oidcDiscovery,
			);
		}
		return {
			type,
			audience: nonEmptyString(
				source.audience,
				`auth.flows[${index}].audience`,
				ManifestParseError,
			),
			exchange: nonEmptyString(
				source.exchange,
				`auth.flows[${index}].exchange`,
				ManifestParseError,
			),
			trust: { oidcDiscovery },
		};
	}
	if (type === "api-key") {
		assertNoExtra(
			source,
			`auth.flows[${index}]`,
			["type", "header", "rotation"],
			ManifestParseError,
		);
		return {
			type,
			header: headerName(
				source.header,
				`auth.flows[${index}].header`,
				ManifestParseError,
			),
			rotation: enumValue(
				source.rotation,
				new Set(["manual"] as const),
				`auth.flows[${index}].rotation`,
				ManifestParseError,
			),
		};
	}
	if (type === "device-code") {
		assertNoExtra(
			source,
			`auth.flows[${index}]`,
			["type", "authorizationServer"],
			ManifestParseError,
		);
		return source.authorizationServer === undefined
			? { type }
			: {
					type,
					authorizationServer: httpsUrl(
						source.authorizationServer,
						`auth.flows[${index}].authorizationServer`,
						ManifestParseError,
					),
				};
	}
	assertNoExtra(
		source,
		`auth.flows[${index}]`,
		["type", "authorizationServer", "audience", "scopes", "idJag"],
		ManifestParseError,
	);
	return {
		type,
		authorizationServer: httpsUrl(
			source.authorizationServer,
			`auth.flows[${index}].authorizationServer`,
			ManifestParseError,
		),
		...(source.audience === undefined
			? undefined
			: {
					audience: nonEmptyString(
						source.audience,
						`auth.flows[${index}].audience`,
						ManifestParseError,
					),
				}),
		scopes: uniqueStringArray(
			source.scopes,
			`auth.flows[${index}].scopes`,
			ManifestParseError,
			{ minLength: 1 },
		),
		...(source.idJag === undefined
			? undefined
			: { idJag: source.idJag === true }),
	};
}

function parseCost(
	input: JsonValue | undefined,
): CapabilityManifestBundle["cost"] {
	const source = expectObject(input, "cost.json", ManifestParseError);
	assertNoExtra(
		source,
		"cost.json",
		["currency", "unitPrices", "freeTier"],
		ManifestParseError,
	);
	const unitPrices = expectObject(
		source.unitPrices,
		"cost.unitPrices",
		ManifestParseError,
	);
	if (Object.keys(unitPrices).length === 0) {
		throw new ManifestParseError(
			"cost.unitPrices",
			"non-empty object",
			source.unitPrices,
		);
	}
	for (const [name, price] of Object.entries(unitPrices)) {
		const entry = expectObject(
			price,
			`cost.unitPrices.${name}`,
			ManifestParseError,
		);
		// SAFETY: assertion required at this I/O or test boundary.
		if (!Number.isFinite(entry.amount) || (entry.amount as number) <= 0) {
			throw new ManifestParseError(
				`cost.unitPrices.${name}.amount`,
				"positive number",
				entry.amount,
			);
		}
	}
	return {
		currency: currency(source.currency, "cost.currency", ManifestParseError),
		// SAFETY: assertion required at this I/O or test boundary.
		unitPrices: cloneJson(
			unitPrices,
		) as CapabilityManifestBundle["cost"]["unitPrices"],
		freeTier:
			source.freeTier === undefined
				? []
				: cloneJson(
						requiredArray(source.freeTier, "cost.freeTier", ManifestParseError),
					),
	};
}

function parseResourceIndicators(input: JsonValue | undefined): string[] {
	return uniqueStringArray(
		input,
		"auth.resourceIndicators",
		ManifestParseError,
		{ minLength: 1 },
	).map((indicator) => {
		if (indicator.startsWith("urn:")) {
			const parts = indicator.split(":");
			if (parts.length < 3 || parts.some((part) => part === "")) {
				throw new ManifestParseError(
					"auth.resourceIndicators",
					"urn:<namespace>:<resource>",
					indicator,
				);
			}
			return indicator;
		}
		httpsUrl(indicator, "auth.resourceIndicators", ManifestParseError);
		return indicator;
	});
}
