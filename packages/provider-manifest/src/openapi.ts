/**
 * OpenAPI 3.x -> the operation table the generators consume.
 *
 * Parse boundary for an untrusted API description: it becomes a
 * `ParsedApiSpec` or a list of issues. Only what a client call needs is read
 * (operations, their parameters, whether a body is sent); schemas are not
 * interpreted, so generated signatures name parameters but type bodies and
 * responses as `unknown`.
 */
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { parseDocument } from "yaml";
import type { ManifestIssue } from "./parse.js";

export const HTTP_METHODS = [
	"get",
	"put",
	"post",
	"delete",
	"patch",
	"head",
	"options",
] as const;

export type ApiParameter = {
	readonly name: string;
	readonly in: "path" | "query" | "header";
	readonly required: boolean;
};

export type ApiOperation = {
	/** A JavaScript identifier, unique within the spec. */
	readonly id: string;
	readonly method: string;
	readonly path: string;
	readonly summary: string;
	readonly parameters: readonly ApiParameter[];
	readonly body: "none" | "optional" | "required";
};

declare const parsedApiBrand: unique symbol;

export type ApiDescription = {
	readonly title: string;
	readonly version: string;
	/** First declared server URL, or "" when the spec names none. */
	readonly baseUrl: string;
	readonly operations: readonly ApiOperation[];
};

/** An API description that crossed the parse boundary. */
export type ParsedApiSpec = ApiDescription & {
	readonly [parsedApiBrand]: true;
};

export type ApiSpecResult =
	| { readonly ok: true; readonly api: ParsedApiSpec }
	| { readonly ok: false; readonly issues: readonly ManifestIssue[] };

function isObject(value: JsonValue | undefined): value is JsonObject {
	return value !== undefined && value !== null && Object(value) === value
		? !Array.isArray(value)
		: false;
}

function text(value: JsonValue | undefined): string {
	return value === undefined || value === null || isObject(value)
		? ""
		: String(value);
}

/**
 * Descriptive text from a spec ends up in tool descriptions and search results
 * a model reads, so it is untrusted input: one line, no control characters, and
 * bounded, so a spec cannot smuggle paragraphs of instructions through a title.
 */
export const MAX_TITLE = 80;
export const MAX_SUMMARY = 160;

function isControl(code: number): boolean {
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x2028 ||
		code === 0x2029
	);
}

function clean(value: string, max: number): string {
	const line = [...value]
		.map((char) => (isControl(char.codePointAt(0) ?? 0) ? " " : char))
		.join("")
		.replace(/\s+/gu, " ")
		.trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** `listPets`, `get /pets/{id}` -> a legal, readable identifier. */
function identifier(raw: string): string {
	const words = raw.split(/[^A-Za-z0-9]+/u).filter((word) => word !== "");
	const joined = words
		.map((word, index) =>
			index === 0 ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
		)
		.join("");
	return /^[0-9]/u.test(joined) || joined === "" ? `op${joined}` : joined;
}

function parameters(
	raw: JsonValue | undefined,
	components: JsonObject,
	path: string,
	issues: ManifestIssue[],
): ApiParameter[] {
	if (!Array.isArray(raw)) return [];
	const parsed: ApiParameter[] = [];
	raw.forEach((entry, index) => {
		let parameter: JsonValue | undefined = entry;
		if (isObject(entry) && entry.$ref !== undefined) {
			const ref = text(entry.$ref);
			const name = ref.startsWith("#/components/parameters/")
				? ref.slice("#/components/parameters/".length)
				: "";
			parameter = name === "" ? undefined : components[name];
			if (parameter === undefined) {
				issues.push({
					path: `${path}.parameters[${index}]`,
					message: `cannot resolve ${JSON.stringify(ref)}; only local #/components/parameters refs are supported`,
				});
				return;
			}
		}
		if (!isObject(parameter)) return;
		const location = text(parameter.in);
		// Cookie parameters are browser state, not something a client sets.
		if (location !== "path" && location !== "query" && location !== "header") {
			return;
		}
		parsed.push({
			name: text(parameter.name),
			in: location,
			required: location === "path" || parameter.required === true,
		});
	});
	return parsed;
}

/** Refine an already-decoded OpenAPI document. */
export function parseOpenApiJson(value: JsonValue | undefined): ApiSpecResult {
	const issues: ManifestIssue[] = [];
	if (!isObject(value)) {
		return {
			ok: false,
			issues: [{ path: "", message: "an OpenAPI document must be an object" }],
		};
	}
	if (!/^3\.[01]\./u.test(text(value.openapi))) {
		issues.push({
			path: "openapi",
			message: `only OpenAPI 3.0 and 3.1 are supported (got ${JSON.stringify(text(value.openapi) || text(value.swagger))})`,
		});
	}
	const info = isObject(value.info) ? value.info : {};
	const servers = Array.isArray(value.servers) ? value.servers : [];
	const firstServer = servers[0];
	const components = isObject(value.components) ? value.components : {};
	const componentParameters = isObject(components.parameters)
		? components.parameters
		: {};

	const operations: ApiOperation[] = [];
	const seen = new Set<string>();
	const paths = isObject(value.paths) ? value.paths : {};
	for (const [path, item] of Object.entries(paths)) {
		if (!isObject(item)) continue;
		const shared = parameters(
			item.parameters,
			componentParameters,
			`paths.${path}`,
			issues,
		);
		for (const method of HTTP_METHODS) {
			const operation = item[method];
			if (!isObject(operation)) continue;
			const where = `paths.${path}.${method}`;
			const id = identifier(text(operation.operationId) || `${method} ${path}`);
			if (seen.has(id)) {
				issues.push({
					path: where,
					message: `operation id ${JSON.stringify(id)} is not unique`,
				});
			}
			seen.add(id);
			// Operation-level parameters override path-level ones of the same name.
			const own = parameters(
				operation.parameters,
				componentParameters,
				where,
				issues,
			);
			const merged = [
				...shared.filter(
					(parameter) =>
						!own.some(
							(other) =>
								other.name === parameter.name && other.in === parameter.in,
						),
				),
				...own,
			];
			for (const parameter of merged) {
				if (parameter.in === "path" && !path.includes(`{${parameter.name}}`)) {
					issues.push({
						path: where,
						message: `path parameter ${JSON.stringify(parameter.name)} does not appear in the path`,
					});
				}
			}
			const requestBody = operation.requestBody;
			operations.push({
				id,
				method: method.toUpperCase(),
				path,
				summary: clean(
					text(operation.summary) || text(operation.description),
					MAX_SUMMARY,
				),
				parameters: merged,
				body: !isObject(requestBody)
					? "none"
					: requestBody.required === true
						? "required"
						: "optional",
			});
		}
	}
	if (operations.length === 0) {
		issues.push({ path: "paths", message: "declares no operations" });
	}
	if (issues.length > 0) return { ok: false, issues };
	const description: ApiDescription = {
		title: clean(text(info.title), MAX_TITLE) || "API",
		version: text(info.version),
		baseUrl: isObject(firstServer) ? text(firstServer.url) : "",
		operations,
	};
	// SAFETY: the brand is conferred here and nowhere else; every check passed.
	return { ok: true, api: description as ParsedApiSpec };
}

/** Parse OpenAPI text. YAML is a superset of JSON, so one reader serves both. */
export function parseOpenApi(source: string): ApiSpecResult {
	const document = parseDocument(source);
	if (document.errors.length > 0) {
		return {
			ok: false,
			issues: document.errors.map((error) => ({
				path: "",
				message: error.message,
			})),
		};
	}
	// SAFETY: yaml's toJS yields plain JSON-shaped data; refined just below.
	return parseOpenApiJson(document.toJS() as JsonValue);
}
