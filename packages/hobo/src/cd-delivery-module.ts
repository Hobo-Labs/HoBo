/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-shape-in-symbol-names -- SAFETY: this is the parse boundary for an untrusted delivery module; module exports are unknown until fromJson parses each record with its generated schema. */

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type DescMessage,
	fromJson,
	isMessage,
	type MessageShape,
	type JsonValue as ProtoJson,
} from "@bufbuild/protobuf";
import {
	type CampSetRecord,
	CampSetRecordSchema,
	type ChangeWindowRecord,
	ChangeWindowRecordSchema,
	type FreightSourceRecord,
	FreightSourceRecordSchema,
	type PipelineRecord,
	PipelineRecordSchema,
	type PlacementRecord,
	PlacementRecordSchema,
	type TrustedPublisherRecord,
	TrustedPublisherRecordSchema,
} from "@hobo/cd";

// public-contract: the delivery module's export names and their record schemas.
export const DELIVERY_MODULE_EXPORTS = Object.freeze({
	sources: FreightSourceRecordSchema,
	pipelines: PipelineRecordSchema,
	windows: ChangeWindowRecordSchema,
	campSets: CampSetRecordSchema,
	placements: PlacementRecordSchema,
	publishers: TrustedPublisherRecordSchema,
} as const);

// public-contract: the delivery module's topology export names.
export const DELIVERY_MODULE_TOPOLOGY_EXPORTS = Object.freeze([
	"yards",
	"camps",
	"rails",
] as const);

// domain-view: parsed delivery module (arrays of generated records).
export type DeliveryModule = Readonly<{
	sources: readonly FreightSourceRecord[];
	pipelines: readonly PipelineRecord[];
	windows: readonly ChangeWindowRecord[];
	campSets: readonly CampSetRecord[];
	placements: readonly PlacementRecord[];
	publishers: readonly TrustedPublisherRecord[];
}>;

export type DeliveryModuleRefusal = Readonly<{
	ok: false;
	code: "delivery-module-unreadable" | "delivery-module-invalid";
	message: string;
	remediation: string;
}>;

export type DeliveryModuleOutcome =
	| Readonly<{ ok: true; value: DeliveryModule }>
	| DeliveryModuleRefusal;

const INVALID_REMEDIATION =
	"Export arrays of records in protobuf JSON form (camelCase fields, enum names) named sources, pipelines, windows, campSets, placements or publishers; see packages/hobo/CD.md.";

function parseRecords<D extends DescMessage>(
	schema: D,
	name: string,
	value: unknown,
): MessageShape<D>[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new TypeError(`export ${name} must be an array of records`);
	return value.map((item, index) => {
		if (isMessage(item, schema)) return item;
		try {
			return fromJson(schema, item as ProtoJson);
		} catch (error) {
			throw new TypeError(
				`${name}[${index}]: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});
}

export function parseDeliveryModule(
	exports: Readonly<Record<string, unknown>>,
): DeliveryModuleOutcome {
	const root =
		typeof exports.default === "object" && exports.default !== null
			?
				(exports.default as Record<string, unknown>)
			: exports;
	const known = new Set<string>([
		...Object.keys(DELIVERY_MODULE_EXPORTS),
		...DELIVERY_MODULE_TOPOLOGY_EXPORTS,
		"PAGES_RELEASE_BUILD_MARGIN_MS",
		"default",
	]);
	const unknown = Object.keys(root).filter((key) => !known.has(key));
	if (unknown.length > 0)
		return {
			ok: false,
			code: "delivery-module-invalid",
			message: `unknown export(s): ${unknown.join(", ")}`,
			remediation: INVALID_REMEDIATION,
		};
	try {
		return {
			ok: true,
			value: Object.freeze({
				sources: parseRecords(
					FreightSourceRecordSchema,
					"sources",
					root.sources,
				),
				pipelines: parseRecords(
					PipelineRecordSchema,
					"pipelines",
					root.pipelines,
				),
				windows: parseRecords(
					ChangeWindowRecordSchema,
					"windows",
					root.windows,
				),
				campSets: parseRecords(CampSetRecordSchema, "campSets", root.campSets),
				placements: parseRecords(
					PlacementRecordSchema,
					"placements",
					root.placements,
				),
				publishers: parseRecords(
					TrustedPublisherRecordSchema,
					"publishers",
					root.publishers,
				),
			}),
		};
	} catch (error) {
		return {
			ok: false,
			code: "delivery-module-invalid",
			message: error instanceof Error ? error.message : String(error),
			remediation: INVALID_REMEDIATION,
		};
	}
}

export type ModuleImporter = (
	path: string,
) => Promise<Readonly<Record<string, unknown>>>;

export const defaultModuleImporter: ModuleImporter = async (path) => {
	const url = pathToFileURL(path).href;
	if (/\.(c|m)?ts$/.test(path)) {
		const { tsImport } = await import("tsx/esm/api");
		return (await tsImport(url, import.meta.url)) as Record<string, unknown>;
	}
	return (await import(url)) as Record<string, unknown>;
};

export async function loadDeliveryFile(
	file: string,
	options: Readonly<{ cwd: string; importModule?: ModuleImporter }>,
): Promise<DeliveryModuleOutcome> {
	const path = resolve(options.cwd, file);
	let exports: Readonly<Record<string, unknown>>;
	try {
		if (extname(path) === ".json") {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			)
				return {
					ok: false,
					code: "delivery-module-invalid",
					message: `${file} must hold a JSON object`,
					remediation: INVALID_REMEDIATION,
				};
			exports = parsed as Record<string, unknown>;
		} else {
			exports = await (options.importModule ?? defaultModuleImporter)(path);
		}
	} catch (error) {
		return {
			ok: false,
			code: "delivery-module-unreadable",
			message: `${file}: ${error instanceof Error ? error.message : String(error)}`,
			remediation:
				"Check the path (relative to --cwd) and that the module loads with `node --import tsx`.",
		};
	}
	return parseDeliveryModule(exports);
}

export type DeliveryKind = keyof typeof DELIVERY_MODULE_EXPORTS;

export async function loadRecordsOf<K extends DeliveryKind>(
	kind: K,
	file: string,
	options: Readonly<{ cwd: string; importModule?: ModuleImporter }>,
): Promise<
	Readonly<{ ok: true; value: DeliveryModule[K] }> | DeliveryModuleRefusal
> {
	const path = resolve(options.cwd, file);
	if (extname(path) === ".json") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(path, "utf8"));
		} catch (error) {
			return {
				ok: false,
				code: "delivery-module-unreadable",
				message: `${file}: ${error instanceof Error ? error.message : String(error)}`,
				remediation: "Check the path (relative to --cwd) and that it is JSON.",
			};
		}
		const isExports =
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed) &&
			Object.keys(parsed).some((key) => key in DELIVERY_MODULE_EXPORTS);
		if (!isExports) {
			const one = parseDeliveryModule({ [kind]: [parsed] });
			return one.ok ? { ok: true, value: one.value[kind] } : one;
		}
	}
	const loaded = await loadDeliveryFile(file, options);
	return loaded.ok ? { ok: true, value: loaded.value[kind] } : loaded;
}

export function deliveryRecordCount(module: DeliveryModule): number {
	return (
		module.publishers.length +
		module.sources.length +
		module.windows.length +
		module.campSets.length +
		module.placements.length +
		module.pipelines.length
	);
}
