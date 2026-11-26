/**
 * Parse, don't validate — the one parser boundary of this experience proof.
 *
 * The untrusted input is a **Bindle manifest graph**: the serialized
 * `bindle(...)` definition an author, a template, or an agent hands to the
 * control plane. Its resources, annotations, and edges are plain JSON by the
 * time anyone reads them, so this module is where they stop being that.
 *
 * `parseSwaghausBindle` turns a manifest into the parsed derived type
 * `SwaghausBindlePlan` over branded `ConvexAppRoot` / `ResourceName` /
 * `EnvName` values, applying the invariants in architecture/bindle.cue:
 * exactly one web Kit carrying the `convexApp(root)` marker, a data backend and
 * a WorkOS external it depends on, no provider pin anywhere on the Bindle
 * (ADR-0024 — escapes are Camp/Yard-scoped), no plaintext secret material in
 * any annotation config (ADR-0027), and one routing per required env name.
 * `src/authoring.ts` and the tests accept only the parsed plan, so an
 * unparsed manifest is unrepresentable past this file.
 */
import type { ProviderAnnotation } from "@hobo/bindles";
import {
	ENV_TO_BINDLE_KIND,
	isConvexWebAppAnnotation,
	resolveConvexRoot,
	SWAGHAUS_GENERAL_ENV,
} from "@hobo/convex";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


declare const brandTag: unique symbol;
type Branded<Tag extends string> = string & { readonly [brandTag]: Tag };

/** Repo-relative Convex app directory (no absolute path, no `..` escape). */
export type ConvexAppRoot = Branded<"ConvexAppRoot">;
/** DNS-safe Bindle resource name. */
export type ResourceName = Branded<"ResourceName">;
/** Environment variable NAME — an authored Bindle never carries values. */
export type EnvName = Branded<"EnvName">;

/** #BindleResourceKind. */
export type BindleResourceKind = "data" | "external" | "web";
/** #EnvRouting. */
export type EnvRouting = "env" | "external" | "data";
/** #AuthoringPhase. */
export type AuthoringPhase = "drafted" | "parsed" | "matched" | "refused";

/** #AuthoringTransitions. */
export const AUTHORING_TRANSITIONS: Readonly<
	Record<AuthoringPhase, readonly AuthoringPhase[]>
> = Object.freeze({
	drafted: Object.freeze(["parsed", "refused"] as const),
	parsed: Object.freeze(["matched", "refused"] as const),
	matched: Object.freeze([] as const),
	refused: Object.freeze([] as const),
});

const RESOURCE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;
const REPO_RELATIVE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/u;
const PATH_ESCAPE = /(^|\/)\.\.(\/|$)/u;
const WORKOS_ENV = /^(VITE_)?WORKOS_/u;

/**
 * Annotation config keys that would mean an author pasted credential material
 * into a Bindle. Secrets ride Camp `secretRef` / broker mint only (ADR-0027).
 */
const SECRET_MATERIAL_KEY = /(secret|token|password|credential|api[_-]?key)/iu;

const RESOURCE_KINDS: readonly BindleResourceKind[] = Object.freeze([
	"data",
	"external",
	"web",
]);

/** Every parser here refuses by throwing, never by dropping a field. */
export class BindleAuthoringParseError extends Error {
	readonly field: string;
	readonly reason: string;

	constructor(field: string, reason: string) {
		super(`${field}: ${reason}`);
		this.name = "BindleAuthoringParseError";
		this.field = field;
		this.reason = reason;
	}
}

function record(value: JsonValue, field: string): JsonObject {
	if (!isJsonObject(value) || value === null || Array.isArray(value)) {
		throw new BindleAuthoringParseError(field, "expected an object");
	}
	// SAFETY: `return value as JsonObject;` is required at this I/O or test boundary.
	return value as JsonObject;
}

/** #RepoRelativePath. */
export function parseConvexAppRoot(
	value: JsonValue,
	options: { readonly repoRoot?: string } = {},
): ConvexAppRoot {
	if (!isJsonString(value) || !REPO_RELATIVE.test(value)) {
		throw new BindleAuthoringParseError(
			"webRoot",
			"expected a repo-relative Convex app directory",
		);
	}
	if (PATH_ESCAPE.test(value)) {
		throw new BindleAuthoringParseError(
			"webRoot",
			"path escapes the repo via ..",
		);
	}
	// Reuse the real containment guard when a repo root is known, so the parsed
	// value satisfies the same rule @hobo/convex applies at resolve time.
	if (options.repoRoot !== undefined) {
		try {
			resolveConvexRoot(options.repoRoot, value);
		} catch (error) {
			throw new BindleAuthoringParseError(
				"webRoot",
				error instanceof Error ? error.message : "root escapes the repo",
			);
		}
	}
	// SAFETY: `return value as ConvexAppRoot;` is required at this I/O or test boundary.
	return value as ConvexAppRoot;
}

/** #ResourceName. */
export function parseResourceName(value: JsonValue): ResourceName {
	if (!isJsonString(value) || !RESOURCE_NAME.test(value)) {
		throw new BindleAuthoringParseError(
			"resource.name",
			"expected a DNS label (lowercase alphanumeric plus inner hyphens)",
		);
	}
	// SAFETY: `return value as ResourceName;` is required at this I/O or test boundary.
	return value as ResourceName;
}

/** #EnvName. */
export function parseEnvName(value: JsonValue): EnvName {
	if (!isJsonString(value) || !ENV_NAME.test(value)) {
		throw new BindleAuthoringParseError(
			"env.name",
			"expected an environment variable NAME",
		);
	}
	// SAFETY: `return value as EnvName;` is required at this I/O or test boundary.
	return value as EnvName;
}

/**
 * #EnvDependency.routing — the routing rules `ENV_TO_BINDLE_KIND` states:
 * WorkOS AuthKit names ride a `b.external()` connector, the Convex URL is an
 * output of the realized `b.data()` resource, and the deploy key is a
 * broker-minted Camp value. An unrecognized name is refused, not defaulted.
 */
export function parseEnvRouting(name: EnvName): EnvRouting {
	if (WORKOS_ENV.test(name)) return "external";
	if (name === "VITE_CONVEX_URL") return "data";
	if (name === "CONVEX_DEPLOY_KEY") return ENV_TO_BINDLE_KIND.CONVEX_DEPLOY_KEY;
	throw new BindleAuthoringParseError(
		"env.name",
		`no Bindle routing is declared for "${name}"`,
	);
}

const ROUTING_VIA: Readonly<Record<EnvRouting, string>> = Object.freeze({
	env: "broker-minted Camp value (never Bindle config)",
	external: "b.external() WorkOS AuthKit connector / Camp secretRef",
	data: "b.data() output realized by Matching → @hobo/provider-convex",
});

/** Parsed derived type for #BindleResourceRef. */
export type BindleResourceView = {
	readonly name: ResourceName;
	readonly kind: BindleResourceKind;
	readonly dependsOn: readonly ResourceName[];
};

interface ParsedBindleResource {
	readonly view: BindleResourceView;
	readonly annotations: readonly ProviderAnnotation[];
}

/** Parsed derived type for #EnvDependency. */
export type EnvDependencyView = {
	readonly name: EnvName;
	readonly routing: EnvRouting;
	readonly via: string;
};

/** Parsed derived type for #SwaghausBindleContract. */
export type SwaghausBindlePlan = {
	readonly appName: ResourceName;
	readonly webRoot: ConvexAppRoot;
	readonly framework: "convex";
	readonly web: BindleResourceView;
	readonly resources: readonly BindleResourceView[];
	readonly envDeps: readonly EnvDependencyView[];
};

function parseAnnotations(
	value: JsonValue,
	resourceName: string,
): readonly ProviderAnnotation[] {
	if (!Array.isArray(value)) {
		throw new BindleAuthoringParseError(
			`${resourceName}.annotations`,
			"expected an array",
		);
	}
	return value.map((entry) => {
		const source = record(entry, `${resourceName}.annotations[]`);
		const provider = source.provider;
		const option = source.option;
		if (!isJsonString(provider) || !isJsonString(option)) {
			throw new BindleAuthoringParseError(
				`${resourceName}.annotations[]`,
				"expected provider and option strings",
			);
		}
		// Bindles carry no provider selection: a vendor-scoped annotation belongs
		// at Camp/Yard scope, where the PortabilityReport can score it.
		if (provider !== "hobo") {
			throw new BindleAuthoringParseError(
				`${resourceName}.annotations[]`,
				`provider pin "${provider}" is not allowed on a Bindle — scope provider options to a Camp or Yard`,
			);
		}
		const config = source.config === undefined ? {} : record(source.config, `${resourceName}.annotations[].config`);
		for (const [key, entryValue] of Object.entries(config)) {
			if (
				SECRET_MATERIAL_KEY.test(key) &&
				isJsonString(entryValue) &&
				entryValue.trim() !== ""
			) {
				throw new BindleAuthoringParseError(
					`${resourceName}.annotations[].config.${key}`,
					"secret material never rides Bindle config — use a Camp secretRef or b.external()",
				);
			}
		}
		return Object.freeze({
			provider,
			option,
			config,
		}) satisfies ProviderAnnotation;
	});
}

function parseResource(
	name: string,
	value: JsonValue,
): ParsedBindleResource {
	const source = record(value, `resources.${name}`);
	const kind = source.kind;
	if (
		!isJsonString(kind) ||
		// SAFETY: `!RESOURCE_KINDS.includes(kind as BindleResourceKind)` is required at this I/O or test boundary.
		!RESOURCE_KINDS.includes(kind as BindleResourceKind)
	) {
		throw new BindleAuthoringParseError(
			`resources.${name}.kind`,
			`expected one of ${RESOURCE_KINDS.join(", ")}`,
		);
	}
	return {
		view: Object.freeze({
			name: parseResourceName(source.name ?? name),
			// SAFETY: `kind: kind as BindleResourceKind,` is required at this I/O or test boundary.
			kind: kind as BindleResourceKind,
			// SAFETY: `dependsOn: Object.freeze([] as ResourceName[]),` is required at this I/O or test boundary.
			dependsOn: Object.freeze([] as ResourceName[]),
		}),
		annotations: parseAnnotations(source.annotations ?? [], name),
	};
}

function parseEdges(
	value: JsonValue,
	known: ReadonlySet<string>,
): readonly { readonly from: ResourceName; readonly to: ResourceName }[] {
	if (!Array.isArray(value)) {
		throw new BindleAuthoringParseError("edges", "expected an array");
	}
	return value.map((entry) => {
		const source = record(entry, "edges[]");
		const from = parseResourceName(source.from);
		const to = parseResourceName(source.to);
		for (const endpoint of [from, to]) {
			if (!known.has(endpoint)) {
				throw new BindleAuthoringParseError(
					"edges[]",
					`edge names unknown resource "${endpoint}"`,
				);
			}
		}
		if (from === to) {
			throw new BindleAuthoringParseError(
				"edges[]",
				`resource "${from}" depends on itself`,
			);
		}
		return Object.freeze({ from, to });
	});
}

/**
 * Parse a Bindle manifest graph into the refined swaghaus plan.
 *
 * Refuses: a provider pin on any resource, plaintext secret material in an
 * annotation config, a missing or duplicated web Kit, a web Kit without the
 * `convexApp(root)` marker, a web Kit that does not depend on both a data
 * backend and an external (WorkOS) dependency, and an env name with no
 * declared Bindle routing.
 */
export function parseSwaghausBindle(
	manifest: JsonValue,
	options: { readonly repoRoot?: string } = {},
): SwaghausBindlePlan {
	const source = record(manifest, "manifest");
	const appName = parseResourceName(source.name);
	const resources = record(source.resources, "resources");

	const parsed = Object.entries(resources).map(([name, value]) => ({
		key: name,
		...parseResource(name, value),
	}));
	const byName = new Map(parsed.map((entry) => [entry.view.name, entry]));
	const edges = parseEdges(source.edges ?? [], new Set(byName.keys()));

	const webs = parsed.filter((entry) => entry.view.kind === "web");
	if (webs.length !== 1) {
		throw new BindleAuthoringParseError(
			"resources",
			`swaghaus is one web Kit; found ${webs.length}`,
		);
	}
	const web = webs[0];
	if (web === undefined) {
		throw new BindleAuthoringParseError("resources", "missing web Kit");
	}

	const convexAnnotation = web.annotations.find(isConvexWebAppAnnotation);
	if (convexAnnotation === undefined) {
		throw new BindleAuthoringParseError(
			`resources.${web.view.name}.annotations`,
			"web Kit is missing the convexApp(root) marker",
		);
	}
	const webRoot = parseConvexAppRoot(convexAnnotation.config.root, options);

	const dependencies = edges
		.filter((edge) => edge.from === web.view.name)
		.map((edge) => edge.to);
	const dependencyKinds = new Set(
		dependencies.map((name) => byName.get(name)?.view.kind),
	);
	for (const required of ["data", "external"] as const) {
		if (!dependencyKinds.has(required)) {
			throw new BindleAuthoringParseError(
				`resources.${web.view.name}.dependsOn`,
				`swaghaus needs a "${required}" dependency (Convex backend + WorkOS AuthKit external)`,
			);
		}
	}

	const envDeps = SWAGHAUS_GENERAL_ENV.map((name) => {
		const envName = parseEnvName(name);
		const routing = parseEnvRouting(envName);
		return Object.freeze({ name: envName, routing, via: ROUTING_VIA[routing] });
	});

	const views = parsed.map((entry) =>
		Object.freeze({
			...entry.view,
			dependsOn: Object.freeze(
				edges
					.filter((edge) => edge.from === entry.view.name)
					.map((edge) => edge.to),
			),
		}),
	);

	return Object.freeze({
		appName,
		webRoot,
		framework: "convex" as const,
		web: Object.freeze({
			...web.view,
			dependsOn: Object.freeze(dependencies),
		}),
		resources: Object.freeze(views),
		envDeps: Object.freeze(envDeps),
	});
}

/** #AuthoringTransitions — refuse a phase move the lifecycle does not allow. */
export function assertAuthoringTransition(
	from: AuthoringPhase,
	to: AuthoringPhase,
): void {
	if (!AUTHORING_TRANSITIONS[from].includes(to)) {
		throw new BindleAuthoringParseError(
			"phase",
			`"${from}" cannot transition to "${to}"`,
		);
	}
}
