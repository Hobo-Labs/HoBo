import { isJsonString } from "../json.js";
import type {
	CapabilityDiagnostic,
	CapabilityUsageResult,
	InferredResourceUsage,
} from "./types.js";

const RESOURCE_FACTORIES = new Map<string, string>([
	["kv", "wasi:keyvalue"],
	["database", "wasi:sql"],
	["data", "hobo:projection"],
	["bucket", "wasi:blobstore"],
	["objectStore", "wasi:blobstore"],
	["queue", "hobo:queue"],
	["topic", "hobo:durable-messaging"],
	["secret", "wasi:config"],
]);

const COMPONENT_FACTORIES = new Set(["api", "service", "web", "job"]);
const FACTORY_NAMES = new Set([
	...RESOURCE_FACTORIES.keys(),
	...COMPONENT_FACTORIES,
]);
const IGNORED_RESOURCE_METHODS = new Set(["allow"]);

const DECLARATION =
	/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*["']([A-Za-z][A-Za-z0-9_-]*)["']\s*\)(?:\s*\.\s*allow\s*\(([^)]*)\))?/g;
const STATIC_CALL =
	/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
const DYNAMIC_CALL =
	/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*((?:\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\[\s*[^\]]+\s*\]\s*\(/g;
const NAMED_BINDLES_IMPORT =
	/import\s*\{([\s\S]*?)\}\s*from\s*["']@hobo\/bindles["']/g;
const NAMESPACE_BINDLES_IMPORT =
	/import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*["']@hobo\/bindles["']/g;

interface MutableResource {
	resource: string;
	variable: string;
	factory: string;
	port?: string;
	component: boolean;
	declaredAllow: string[];
	operations: Set<string>;
}

interface BindlesImports {
	named: Map<string, string>;
	namespaces: Set<string>;
}

export function inferCapabilityUsage({
	sourceText,
	fileName = "bindle.ts",
}: {
	sourceText: string;
	fileName?: string;
}): CapabilityUsageResult {
	if (!isJsonString(sourceText)) {
		throw new TypeError("sourceText must be a string");
	}

	const imports = parseBindlesImports(sourceText);
	const lineStarts = findLineStarts(sourceText);
	const resourcesByVariable = new Map<string, MutableResource>();
	const resourcesById = new Map<string, MutableResource>();
	const diagnostics: CapabilityDiagnostic[] = [];

	for (const match of sourceText.matchAll(DECLARATION)) {
		const [, variable, qualifier, callee, resourceId, allowText] = match;
		if (!variable || !callee || !resourceId) {
			continue;
		}
		const factoryInput = qualifier
			? { qualifier, callee, imports }
			: { callee, imports };
		if (!isBindlesFactory(factoryInput)) {
			continue;
		}

		const factory = canonicalFactory(factoryInput);
		if (!factory) {
			continue;
		}

		const port = RESOURCE_FACTORIES.get(factory);
		const resource: MutableResource = {
			resource: resourceId,
			variable,
			factory,
			...(port !== undefined ? { port } : undefined),
			component: COMPONENT_FACTORIES.has(factory),
			declaredAllow: parseAllowList(allowText ?? ""),
			operations: new Set<string>(),
		};
		resourcesByVariable.set(variable, resource);
		resourcesById.set(resourceId, resource);
	}

	for (const match of sourceText.matchAll(DYNAMIC_CALL)) {
		const variable = match[1];
		if (!variable) {
			continue;
		}
		const resource = resourcesByVariable.get(variable);
		if (!resource || resource.component) {
			continue;
		}
		const prefix =
			(match[2] ?? "")
				.split(".")
				.map((part) => part.trim())
				.filter(Boolean)
				.join(".") || "(root)";
		diagnostics.push({
			code: "capability.usage.cannot-prove-operation",
			severity: "error",
			resource: resource.resource,
			operationPrefix: prefix,
			fileName,
			line: lineAt(lineStarts, match.index ?? 0),
			message: `Static analysis cannot prove capability operation for ${resource.resource}; capability grants must fail closed.`,
		});
	}

	for (const match of sourceText.matchAll(STATIC_CALL)) {
		const variable = match[1];
		const method = match[2];
		if (!variable || !method) {
			continue;
		}
		const resource = resourcesByVariable.get(variable);
		if (
			!resource ||
			resource.component ||
			IGNORED_RESOURCE_METHODS.has(method)
		) {
			continue;
		}
		resource.operations.add(method);
	}

	const resources: readonly InferredResourceUsage[] = Object.freeze(
		[...resourcesById.values()].map((resource) =>
			Object.freeze({
				resource: resource.resource,
				factory: resource.factory,
				...(resource.port !== undefined ? { port: resource.port } : undefined),
				declaredAllow: Object.freeze([...resource.declaredAllow].sort()),
				operations: Object.freeze([...resource.operations].sort()),
			}),
		),
	);

	return Object.freeze({
		ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
		resources,
		diagnostics: Object.freeze(diagnostics),
	});
}

function parseBindlesImports(sourceText: string): BindlesImports {
	const named = new Map<string, string>();
	const namespaces = new Set<string>();

	for (const match of sourceText.matchAll(NAMED_BINDLES_IMPORT)) {
		const block = match[1];
		if (!block) {
			continue;
		}
		for (const specifier of block.split(",")) {
			const trimmed = specifier.trim().replace(/^type\s+/, "");
			const parts = trimmed.split(/\s+as\s+/);
			const imported = parts[0]?.trim();
			const local = parts[1]?.trim() ?? imported;
			if (imported && FACTORY_NAMES.has(imported) && local) {
				named.set(local, imported);
			}
		}
	}

	for (const match of sourceText.matchAll(NAMESPACE_BINDLES_IMPORT)) {
		const namespace = match[1];
		if (namespace) {
			namespaces.add(namespace);
		}
	}

	return { named, namespaces };
}

function canonicalFactory(input: {
	qualifier?: string;
	callee: string;
	imports: BindlesImports;
}): string | undefined {
	if (
		input.qualifier &&
		input.imports.namespaces.has(input.qualifier) &&
		FACTORY_NAMES.has(input.callee)
	) {
		return input.callee;
	}
	return input.imports.named.get(input.callee);
}

function isBindlesFactory(input: {
	qualifier?: string;
	callee: string;
	imports: BindlesImports;
}): boolean {
	return Boolean(canonicalFactory(input));
}

function parseAllowList(allowText: string): string[] {
	return [...allowText.matchAll(/["']([^"']+)["']/g)].map(
		(match) => match[1] ?? "",
	);
}

function findLineStarts(sourceText: string): number[] {
	const starts = [0];
	for (let index = 0; index < sourceText.length; index += 1) {
		if (sourceText[index] === "\n") {
			starts.push(index + 1);
		}
	}
	return starts;
}

function lineAt(lineStarts: number[], index: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const start = lineStarts[middle];
		if (start !== undefined && start <= index) {
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return high + 1;
}
