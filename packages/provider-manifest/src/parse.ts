/**
 * The parse boundary. Untrusted YAML/JSON text becomes a
 * `ParsedProviderManifest` or a complete list of issues — never a partially
 * checked DTO. Every lowering in this package accepts only the parsed type.
 *
 * The CUE file pins the same constraints for fixtures at build time; this is
 * the runtime side, because a community manifest never passes through `cue vet`.
 */
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { parseProfileId } from "@hobo/manifest-capability";
import {
	compareDecimal,
	type Decimal,
	divideDecimal,
	multiplyDecimal,
	parseDecimal,
} from "@hobo/pricing";
import { parseDocument, visit } from "yaml";
import {
	type ApiSection,
	type AuthFlow,
	type AuthSection,
	type BillingPlan,
	type BillingSection,
	type CapabilitySection,
	type Charge,
	type MeteredCharge,
	type OAuth2Flow,
	type ProviderManifest,
	ProviderManifestSchema,
	type TierList,
} from "./_generated/provider_manifest_pb.js";

// public-contract: the schema id every provider manifest document carries.
export const PROVIDER_MANIFEST_SCHEMA = "hobo.provider-manifest/v1";

export const OAUTH2_GRANTS = [
	"authorization-code",
	"client-credentials",
	"device-code",
	"token-exchange",
	"jwt-bearer",
] as const;
export type OAuth2Grant = (typeof OAUTH2_GRANTS)[number];

export const CLIENT_REGISTRATIONS = [
	"static",
	"dynamic",
	"client-id-metadata-document",
] as const;
export const STABILITIES = ["stable", "preview", "experimental"] as const;
export const AGGREGATIONS = ["sum", "max", "latest", "unique-count"] as const;
export const RECURRING_INTERVALS = [
	"once",
	"daily",
	"weekly",
	"monthly",
	"yearly",
] as const;
export const TIMINGS = ["advance", "arrears"] as const;
/** Spec standards a manifest may name. Generation covers `openapi` today. */
export const API_FORMATS = ["openapi", "asyncapi", "graphql", "grpc"] as const;
export const MCP_TRANSPORTS = ["streamable-http", "sse"] as const;
export const INCLUDED_RESETS = [
	"none",
	"daily",
	"weekly",
	"monthly",
	"yearly",
] as const;

export type ManifestIssue = {
	/** Dotted path into the document, e.g. `billing.products[0].plans[1]`. */
	readonly path: string;
	readonly message: string;
};

declare const parsedBrand: unique symbol;

/** A manifest that crossed the parse boundary. Construct only by parsing. */
export type ParsedProviderManifest = ProviderManifest & {
	readonly [parsedBrand]: true;
};

export type ParseResult =
	| { readonly ok: true; readonly manifest: ParsedProviderManifest }
	| { readonly ok: false; readonly issues: readonly ManifestIssue[] };

export type ManifestFormat = "yaml" | "json";

const SLUG = /^[a-z0-9][a-z0-9._-]*$/u;
const MAPPING_ID = /^[a-z0-9][A-Za-z0-9._/-]*$/u;
const PORT = /^[A-Za-z][A-Za-z0-9-]*$/u;
const SCOPE = /^[A-Za-z0-9:._/-]+$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u;
const EXTENSION_TYPE = /^x-[a-z0-9][a-z0-9-]*$/u;
const HTTP_HEADER = /^[A-Za-z0-9-]+$/u;

class Checker {
	readonly issues: ManifestIssue[] = [];

	fail(path: string, message: string): void {
		this.issues.push({ path, message });
	}

	pattern(path: string, value: string, pattern: RegExp, what: string): boolean {
		if (pattern.test(value)) return true;
		this.fail(path, `must be ${what} (got ${JSON.stringify(value)})`);
		return false;
	}

	oneOf(path: string, value: string, allowed: readonly string[]): void {
		if (!allowed.includes(value)) {
			this.fail(
				path,
				`must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`,
			);
		}
	}

	/** An omitted vocabulary field takes the documented default at lowering. */
	optionalOneOf(path: string, value: string, allowed: readonly string[]): void {
		if (value !== "") this.oneOf(path, value, allowed);
	}

	https(path: string, value: string): void {
		let protocol: string | undefined;
		try {
			protocol = new URL(value).protocol;
		} catch {
			protocol = undefined;
		}
		if (protocol !== "https:") {
			this.fail(path, `must be an https URL (got ${JSON.stringify(value)})`);
		}
	}

	optionalHttps(path: string, value: string): void {
		if (value !== "") this.https(path, value);
	}

	decimal(path: string, value: string, bound: "non-negative" | "positive") {
		const parsed = parseDecimal(value);
		const ok =
			parsed !== undefined &&
			(bound === "positive"
				? parsed.coefficient > 0n
				: parsed.coefficient >= 0n);
		if (!ok) {
			this.fail(
				path,
				`must be a ${bound} decimal string such as "0.25" (got ${JSON.stringify(value)})`,
			);
		}
		return ok ? parsed : undefined;
	}

	unique(path: string, ids: readonly string[]): void {
		const seen = new Set<string>();
		for (const id of ids) {
			if (seen.has(id))
				this.fail(path, `id ${JSON.stringify(id)} is declared twice`);
			seen.add(id);
		}
	}
}

/** `amount / per` when that quotient is an exact decimal, else undefined. */
export function perUnitPrice(
	amount: Decimal,
	per: Decimal,
): Decimal | undefined {
	const quotient = divideDecimal(amount, per);
	if (quotient === undefined) return undefined;
	return compareDecimal(multiplyDecimal(quotient, per), amount) === 0
		? quotient
		: undefined;
}

function checkOAuth2(c: Checker, path: string, flow: OAuth2Flow): void {
	c.oneOf(`${path}.grant`, flow.grant, OAUTH2_GRANTS);
	c.optionalHttps(`${path}.authorizationEndpoint`, flow.authorizationEndpoint);
	c.optionalHttps(`${path}.tokenEndpoint`, flow.tokenEndpoint);
	c.optionalHttps(
		`${path}.deviceAuthorizationEndpoint`,
		flow.deviceAuthorizationEndpoint,
	);
	c.optionalHttps(`${path}.metadataUrl`, flow.metadataUrl);
	c.optionalHttps(`${path}.registrationEndpoint`, flow.registrationEndpoint);
	c.optionalOneOf(
		`${path}.clientRegistration`,
		flow.clientRegistration,
		CLIENT_REGISTRATIONS,
	);
	// Endpoints are either spelled out or discoverable; a flow with neither is
	// a flow nobody can run.
	const discoverable = flow.metadataUrl !== "";
	if (!discoverable && flow.tokenEndpoint === "") {
		c.fail(path, "needs tokenEndpoint or metadataUrl");
	}
	if (flow.grant === "authorization-code") {
		if (!discoverable && flow.authorizationEndpoint === "") {
			c.fail(path, "authorization-code needs authorizationEndpoint");
		}
		// PKCE is not optional for a public agent client; "plain" is refused.
		c.optionalOneOf(`${path}.pkce`, flow.pkce, ["S256"]);
	} else if (flow.pkce !== "") {
		c.fail(`${path}.pkce`, "only applies to the authorization-code grant");
	}
	if (
		flow.grant === "device-code" &&
		!discoverable &&
		flow.deviceAuthorizationEndpoint === ""
	) {
		c.fail(path, "device-code needs deviceAuthorizationEndpoint");
	}
}

function checkFlow(c: Checker, path: string, flow: AuthFlow): void {
	c.pattern(`${path}.id`, flow.id, SLUG, "a lowercase slug");
	c.unique(
		`${path}.scopes`,
		flow.scopes.map((scope) => scope.name),
	);
	flow.scopes.forEach((scope, index) => {
		c.pattern(
			`${path}.scopes[${index}].name`,
			scope.name,
			SCOPE,
			"a well-formed scope",
		);
	});
	const variant = flow.flow;
	switch (variant.case) {
		case "oauth2":
			checkOAuth2(c, `${path}.oauth2`, variant.value);
			break;
		case "authMd":
			c.https(`${path}.authMd.resource`, variant.value.resource);
			c.optionalHttps(`${path}.authMd.documentUrl`, variant.value.documentUrl);
			break;
		case "oidcFederation":
			if (variant.value.audience === "") {
				c.fail(`${path}.oidcFederation.audience`, "is required");
			}
			break;
		case "apiKey":
			c.pattern(
				`${path}.apiKey.header`,
				variant.value.header,
				HTTP_HEADER,
				"an HTTP header name",
			);
			c.optionalOneOf(`${path}.apiKey.rotation`, variant.value.rotation, [
				"manual",
				"automatic",
			]);
			break;
		case "extension":
			c.pattern(
				`${path}.extension.type`,
				variant.value.type,
				EXTENSION_TYPE,
				'an extension type starting with "x-"',
			);
			break;
		default:
			c.fail(
				path,
				"must declare exactly one of oauth2, authMd, oidcFederation, apiKey, extension",
			);
	}
}

function checkAuth(c: Checker, auth: AuthSection): void {
	c.https("auth.issuer", auth.issuer);
	if (auth.flows.length === 0) c.fail("auth.flows", "needs at least one flow");
	c.unique(
		"auth.flows",
		auth.flows.map((flow) => flow.id),
	);
	auth.flows.forEach((flow, index) => {
		checkFlow(c, `auth.flows[${index}]`, flow);
	});
	if (auth.tokenLifetimeSec < 0 || auth.tokenLifetimeSec > 86_400) {
		c.fail("auth.tokenLifetimeSec", "must be between 1 and 86400 seconds");
	}
}

function checkCapabilities(
	c: Checker,
	capabilities: CapabilitySection,
	productIds: ReadonlySet<string>,
): void {
	if (capabilities.mappings.length === 0) {
		c.fail("capabilities.mappings", "needs at least one mapping");
	}
	c.unique(
		"capabilities.mappings",
		capabilities.mappings.map((mapping) => mapping.id),
	);
	capabilities.mappings.forEach((mapping, index) => {
		const path = `capabilities.mappings[${index}]`;
		c.pattern(`${path}.id`, mapping.id, MAPPING_ID, "a mapping id");
		c.pattern(`${path}.port`, mapping.port, PORT, "a HoBo port name");
		if (mapping.providerService === "") {
			c.fail(`${path}.providerService`, "is required");
		}
		c.optionalOneOf(`${path}.stability`, mapping.stability, STABILITIES);
		if (mapping.regions.length === 0 && capabilities.regions.length === 0) {
			c.fail(
				`${path}.regions`,
				"needs regions here or in capabilities.regions",
			);
		}
		mapping.profiles.forEach((profile, profileIndex) => {
			try {
				parseProfileId(profile);
			} catch (error) {
				c.fail(
					`${path}.profiles[${profileIndex}]`,
					error instanceof Error ? error.message : String(error),
				);
			}
		});
		mapping.products.forEach((product, productIndex) => {
			if (!productIds.has(product)) {
				c.fail(
					`${path}.products[${productIndex}]`,
					`references unknown billing product ${JSON.stringify(product)}`,
				);
			}
		});
	});
}

function checkTiers(c: Checker, path: string, list: TierList): void {
	if (list.tiers.length === 0) c.fail(path, "needs at least one tier");
	let previous: Decimal | undefined;
	list.tiers.forEach((tier, index) => {
		const tierPath = `${path}.tiers[${index}]`;
		c.decimal(`${tierPath}.unitPrice`, tier.unitPrice, "non-negative");
		if (tier.flatFee !== "") {
			c.decimal(`${tierPath}.flatFee`, tier.flatFee, "non-negative");
		}
		const last = index === list.tiers.length - 1;
		if (tier.upTo === undefined) {
			if (!last) c.fail(`${tierPath}.upTo`, "only the last tier may omit upTo");
			return;
		}
		if (last) {
			// A closed last tier leaves usage above it with no price at all.
			c.fail(`${tierPath}.upTo`, "the last tier must be open-ended");
		}
		const bound = c.decimal(`${tierPath}.upTo`, tier.upTo, "positive");
		if (bound === undefined) return;
		if (previous !== undefined && compareDecimal(bound, previous) <= 0) {
			c.fail(`${tierPath}.upTo`, "tiers must ascend");
		}
		previous = bound;
	});
}

function checkMetered(
	c: Checker,
	path: string,
	metered: MeteredCharge,
	billableIds: ReadonlySet<string>,
): void {
	if (!billableIds.has(metered.billable)) {
		c.fail(
			`${path}.billable`,
			`references unknown billable ${JSON.stringify(metered.billable)}`,
		);
	}
	c.optionalOneOf(`${path}.timing`, metered.timing, TIMINGS);
	const rate = metered.rate;
	switch (rate.case) {
		case "unitPrice":
			c.decimal(`${path}.unitPrice`, rate.value, "non-negative");
			break;
		case "package": {
			const per = c.decimal(`${path}.package.per`, rate.value.per, "positive");
			const amount = c.decimal(
				`${path}.package.amount`,
				rate.value.amount,
				"non-negative",
			);
			if (
				per !== undefined &&
				amount !== undefined &&
				!rate.value.whole &&
				perUnitPrice(amount, per) === undefined
			) {
				// Pro-rata lowers to an exact per-unit price; a rate that cannot
				// be written exactly would silently drift from the published one.
				c.fail(
					`${path}.package`,
					"amount / per is not an exact decimal; set whole: true or restate the rate",
				);
			}
			break;
		}
		case "graduated":
		case "volume":
			checkTiers(c, `${path}.${rate.case}`, rate.value);
			break;
		default:
			c.fail(
				path,
				"must declare exactly one of unitPrice, package, graduated, volume",
			);
	}
}

function checkCharge(
	c: Checker,
	path: string,
	charge: Charge,
	billableIds: ReadonlySet<string>,
): void {
	c.pattern(`${path}.id`, charge.id, SLUG, "a lowercase slug");
	const model = charge.model;
	switch (model.case) {
		case "recurring":
			c.oneOf(
				`${path}.recurring.interval`,
				model.value.interval,
				RECURRING_INTERVALS,
			);
			c.decimal(`${path}.recurring.amount`, model.value.amount, "non-negative");
			c.optionalOneOf(`${path}.recurring.timing`, model.value.timing, TIMINGS);
			if (model.value.per !== "" && !billableIds.has(model.value.per)) {
				c.fail(
					`${path}.recurring.per`,
					`references unknown billable ${JSON.stringify(model.value.per)}`,
				);
			}
			break;
		case "metered":
			checkMetered(c, `${path}.metered`, model.value, billableIds);
			break;
		case "external":
			c.pattern(
				`${path}.external.model`,
				model.value.model,
				EXTENSION_TYPE,
				'an extension model starting with "x-"',
			);
			break;
		default:
			c.fail(path, "must declare exactly one of recurring, metered, external");
	}
}

function checkPlan(
	c: Checker,
	path: string,
	plan: BillingPlan,
	billableIds: ReadonlySet<string>,
): void {
	c.pattern(`${path}.id`, plan.id, SLUG, "a lowercase slug");
	if (plan.charges.length === 0) {
		c.fail(`${path}.charges`, "needs at least one charge");
	}
	c.unique(
		`${path}.charges`,
		plan.charges.map((charge) => charge.id),
	);
	plan.charges.forEach((charge, index) => {
		checkCharge(c, `${path}.charges[${index}]`, charge, billableIds);
	});
	plan.included.forEach((included, index) => {
		const includedPath = `${path}.included[${index}]`;
		if (!billableIds.has(included.billable)) {
			c.fail(
				`${includedPath}.billable`,
				`references unknown billable ${JSON.stringify(included.billable)}`,
			);
		}
		c.decimal(`${includedPath}.quantity`, included.quantity, "non-negative");
		c.optionalOneOf(`${includedPath}.reset`, included.reset, INCLUDED_RESETS);
	});
}

function checkBilling(c: Checker, billing: BillingSection): void {
	c.pattern("billing.currency", billing.currency, CURRENCY, "an ISO 4217 code");
	if (billing.version === "") c.fail("billing.version", "is required");
	c.pattern(
		"billing.effectiveFrom",
		billing.effectiveFrom,
		UTC_TIMESTAMP,
		"a UTC timestamp like 2026-01-01T00:00:00Z",
	);
	if (billing.effectiveUntil !== undefined) {
		c.pattern(
			"billing.effectiveUntil",
			billing.effectiveUntil,
			UTC_TIMESTAMP,
			"a UTC timestamp",
		);
		// Instants, not strings: "…:00.5Z" sorts before "…:00Z" lexically.
		if (
			Date.parse(billing.effectiveUntil) <= Date.parse(billing.effectiveFrom)
		) {
			c.fail("billing.effectiveUntil", "must be after effectiveFrom");
		}
	}
	// Transcribed prices are ranking input; they always name where they came
	// from and when a human last looked (AGENTS.md legal hygiene).
	if (billing.source === undefined) {
		c.fail("billing.source", "is required: prices carry a source and a date");
	} else {
		c.https("billing.source.url", billing.source.url);
		c.pattern(
			"billing.source.checkedAt",
			billing.source.checkedAt,
			DATE,
			"a date like 2026-01-31",
		);
	}

	c.unique(
		"billing.billables",
		billing.billables.map((billable) => billable.id),
	);
	billing.billables.forEach((billable, index) => {
		const path = `billing.billables[${index}]`;
		c.pattern(`${path}.id`, billable.id, SLUG, "a lowercase slug");
		c.pattern(`${path}.category`, billable.category, SLUG, "a lowercase slug");
		if (billable.unit === "") c.fail(`${path}.unit`, "is required");
		c.optionalOneOf(`${path}.aggregation`, billable.aggregation, AGGREGATIONS);
		if (billable.increment !== "") {
			c.decimal(`${path}.increment`, billable.increment, "positive");
		}
	});
	const billableIds = new Set(billing.billables.map((billable) => billable.id));

	if (billing.products.length === 0) {
		c.fail("billing.products", "needs at least one product");
	}
	c.unique(
		"billing.products",
		billing.products.map((product) => product.id),
	);
	billing.products.forEach((product, index) => {
		const path = `billing.products[${index}]`;
		c.pattern(`${path}.id`, product.id, SLUG, "a lowercase slug");
		c.pattern(`${path}.kind`, product.kind, SLUG, "a lowercase slug");
		product.billables.forEach((billable, billableIndex) => {
			if (!billableIds.has(billable)) {
				c.fail(
					`${path}.billables[${billableIndex}]`,
					`references unknown billable ${JSON.stringify(billable)}`,
				);
			}
		});
		if (product.plans.length === 0) {
			c.fail(`${path}.plans`, "needs at least one plan");
		}
		c.unique(
			`${path}.plans`,
			product.plans.map((plan) => plan.id),
		);
		product.plans.forEach((plan, planIndex) => {
			checkPlan(c, `${path}.plans[${planIndex}]`, plan, billableIds);
		});
		// The pricing catalog requires every product to name what it sells.
		const sells =
			product.billables.length > 0 ||
			product.plans.some((plan) =>
				plan.charges.some(
					(charge) =>
						charge.model.case === "metered" ||
						(charge.model.case === "recurring" &&
							charge.model.value.per !== ""),
				),
			);
		if (!sells) {
			c.fail(
				`${path}.billables`,
				"a product whose charges name no billable must list at least one",
			);
		}
	});
}

function checkApi(
	c: Checker,
	api: ApiSection,
	flowIds: ReadonlySet<string>,
): void {
	if (api.specs.length === 0 && api.mcpServers.length === 0) {
		c.fail("api", "needs at least one spec or MCP server");
	}
	const checkAuth = (path: string, refs: readonly string[]) => {
		refs.forEach((ref, index) => {
			if (!flowIds.has(ref)) {
				c.fail(
					`${path}.auth[${index}]`,
					`references unknown auth flow ${JSON.stringify(ref)}`,
				);
			}
		});
	};
	c.unique(
		"api.specs",
		api.specs.map((spec) => spec.id),
	);
	api.specs.forEach((spec, index) => {
		const path = `api.specs[${index}]`;
		c.pattern(`${path}.id`, spec.id, SLUG, "a lowercase slug");
		if (!EXTENSION_TYPE.test(spec.format)) {
			c.oneOf(`${path}.format`, spec.format, [...API_FORMATS, "x-…"]);
		}
		if ((spec.url === "") === (spec.path === "")) {
			c.fail(path, "must declare exactly one of url, path");
		}
		c.optionalHttps(`${path}.url`, spec.url);
		// A spec file travels with the manifest; it never reaches outside it.
		if (spec.path.startsWith("/") || spec.path.split(/[\\/]/u).includes("..")) {
			c.fail(
				`${path}.path`,
				"must be a relative path inside the manifest's directory",
			);
		}
		c.optionalHttps(`${path}.baseUrl`, spec.baseUrl);
		checkAuth(path, spec.auth);
	});
	c.unique(
		"api.mcpServers",
		api.mcpServers.map((server) => server.id),
	);
	api.mcpServers.forEach((server, index) => {
		const path = `api.mcpServers[${index}]`;
		c.pattern(`${path}.id`, server.id, SLUG, "a lowercase slug");
		c.https(`${path}.url`, server.url);
		c.optionalOneOf(`${path}.transport`, server.transport, MCP_TRANSPORTS);
		checkAuth(path, server.auth);
	});
}

/** Refine a decoded message. Exported for callers that already hold JSON. */
export function parseProviderManifestJson(value: JsonValue): ParseResult {
	let manifest: ProviderManifest;
	try {
		manifest = fromJson(ProviderManifestSchema, value);
	} catch (error) {
		return {
			ok: false,
			issues: [
				{
					path: "",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
	const c = new Checker();
	if (manifest.schema !== PROVIDER_MANIFEST_SCHEMA) {
		c.fail("schema", `must be ${PROVIDER_MANIFEST_SCHEMA}`);
	}
	if (manifest.provider === undefined) {
		c.fail("provider", "is required");
	} else {
		c.pattern("provider.id", manifest.provider.id, SLUG, "a lowercase slug");
		if (manifest.provider.displayName === "") {
			c.fail("provider.displayName", "is required");
		}
		c.optionalHttps("provider.homepage", manifest.provider.homepage);
	}
	if (
		manifest.auth === undefined &&
		manifest.capabilities === undefined &&
		manifest.billing === undefined &&
		manifest.api === undefined
	) {
		c.fail("", "needs at least one of auth, capabilities, billing, api");
	}
	if (manifest.api !== undefined) {
		checkApi(
			c,
			manifest.api,
			new Set(manifest.auth?.flows.map((flow) => flow.id)),
		);
	}
	if (manifest.auth !== undefined) checkAuth(c, manifest.auth);
	if (manifest.billing !== undefined) checkBilling(c, manifest.billing);
	if (manifest.capabilities !== undefined) {
		checkCapabilities(
			c,
			manifest.capabilities,
			new Set(manifest.billing?.products.map((product) => product.id)),
		);
	}
	if (c.issues.length > 0) return { ok: false, issues: c.issues };
	// SAFETY: the brand is conferred here and nowhere else; every check passed.
	return { ok: true, manifest: manifest as ParsedProviderManifest };
}

function readYaml(
	text: string,
): { value: JsonValue } | { issues: readonly ManifestIssue[] } {
	const document = parseDocument(text);
	if (document.errors.length > 0) {
		return {
			issues: document.errors.map((error) => ({
				path: "",
				message: error.message,
			})),
		};
	}
	// A YAML author writes `amount: 0.10`. Decoding that as a float would turn
	// money into 0.1 and then into binary; keep the digits exactly as written.
	visit(document, {
		Scalar(_key, node) {
			if (Number.isFinite(node.value) && node.source !== undefined) {
				node.value = node.source;
			}
		},
	});
	// SAFETY: yaml's toJS yields plain JSON-shaped data; fromJson refines it next.
	return { value: document.toJS() as JsonValue };
}

/** Parse manifest text. YAML is the default authoring format. */
export function parseProviderManifest(
	text: string,
	format: ManifestFormat = "yaml",
): ParseResult {
	if (format === "json") {
		try {
			// SAFETY: JSON.parse yields only JSON values; fromJson refines it next.
			return parseProviderManifestJson(JSON.parse(text) as JsonValue);
		} catch (error) {
			return {
				ok: false,
				issues: [
					{
						path: "",
						message: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}
	}
	const read = readYaml(text);
	if ("issues" in read) return { ok: false, issues: read.issues };
	return parseProviderManifestJson(read.value);
}
