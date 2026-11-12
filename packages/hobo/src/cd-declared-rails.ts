/**
 * Station Rails declared in topology files (`--yard`, HOBO_CD_TOPOLOGY, a
 * delivery module applied with `pipeline apply --file`): the `rails` export.
 *
 * A Rail decides what a Station's CD may touch: which Camp sets it binds
 * (`delivery.campSets`) and which providers it approves
 * (`approvedProviders`). Placement fails closed without them
 * (`rail-providers-unknown`, `set-not-bound`). A repository that delivers
 * itself (the runner fleet's `hobo.delivery.ts`) declares its Rail beside its
 * Camps, so the Station it runs on can decide placement for them.
 *
 * Each declaration is built with `@hobo/stations` `createRail`, so its content
 * digest is computed here, never taken from the file. An empty `stationId`
 * is the Station the CD runtime composes. A Rail the Station's journal
 * activated wins over a declared one: the declared Rail is the Station's Rail
 * only while its journal has none active.
 */

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { type Digest, type Outcome, ReasonRecordSchema } from "@hobo/cd";
import type { RailCatalog, RailCatalogEntry } from "@hobo/cd/compose";
import { createRail } from "@hobo/stations";
import {
	defaultModuleImporter,
	type ModuleImporter,
} from "./cd-delivery-module.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "./json.js";

// public-contract: the topology export that declares Station Rails.
export const DECLARED_RAILS_EXPORT = "rails";

// domain-view: one declared Rail as the catalog serves it.
export type DeclaredRail = Readonly<{
	entry: RailCatalogEntry;
	approvedProviders: readonly string[];
}>;

type RailRefusal = Readonly<{
	ok: false;
	code: "cd-topology-invalid";
	message: string;
	remediation: string;
}>;

const REMEDIATION =
	"Export `rails` as an array of Rail declarations {id, name, version, stationId (empty for this Station), approvedProviders: [provider...], delivery: {campSets: [...]}}; see packages/hobo/CD.md.";

function strings(value: unknown, at: string): readonly string[] {
	if (value === undefined) return [];
	if (!isJsonArray(value) || !value.every((item) => isJsonString(item)))
		throw new TypeError(`${at} must be an array of strings`);
	return value.filter((item): item is string => isJsonString(item));
}

function text(value: unknown, at: string): string {
	if (!isJsonString(value) || value.trim() === "")
		throw new TypeError(`${at} is required`);
	return value;
}

/** Parse one `rails[i]` declaration into a content-addressed Rail. */
function parseRail(
	value: unknown,
	at: string,
	stationId: string,
): DeclaredRail {
	if (!isJsonObject(value)) throw new TypeError(`${at} must be an object`);
	const known = new Set([
		"id",
		"name",
		"version",
		"stationId",
		"approvedProviders",
		"delivery",
		"metadata",
	]);
	const unknown = Object.keys(value).filter((key) => !known.has(key));
	if (unknown.length > 0)
		throw new TypeError(`${at}: unknown field(s) ${unknown.join(", ")}`);
	const declaredStation = isJsonString(value.stationId) ? value.stationId : "";
	const approvedProviders = strings(
		value.approvedProviders,
		`${at}.approvedProviders`,
	);
	if (approvedProviders.length === 0)
		throw new TypeError(
			`${at}.approvedProviders must name at least one provider`,
		);
	const delivery = value.delivery;
	if (delivery !== undefined && !isJsonObject(delivery))
		throw new TypeError(`${at}.delivery must be an object`);
	const metadata: Record<string, string> = {};
	if (value.metadata !== undefined) {
		if (!isJsonObject(value.metadata))
			throw new TypeError(`${at}.metadata must be an object of strings`);
		for (const [key, item] of Object.entries(value.metadata)) {
			if (!isJsonString(item))
				throw new TypeError(`${at}.metadata.${key} must be a string`);
			metadata[key] = item;
		}
	}
	const rail = createRail({
		id: text(value.id, `${at}.id`),
		name: text(value.name, `${at}.name`),
		version: text(value.version, `${at}.version`),
		stationId: declaredStation === "" ? stationId : declaredStation,
		approvedProviders,
		metadata,
		activationStatus: "active",
		...(delivery !== undefined ? { delivery } : undefined),
	});
	// SAFETY: createRail returns a sha256 content digest.
	const railDigest = rail.contentHash as Digest;
	return Object.freeze({
		entry: Object.freeze({
			railId: rail.id,
			railDigest,
			stationId: rail.stationId,
			status: "active",
			// SAFETY: createRail parsed delivery as a JSON object.
			...(rail.delivery !== undefined
				? { delivery: rail.delivery as JsonObject }
				: undefined),
		}),
		approvedProviders: Object.freeze([...rail.approvedProviders]),
	});
}

/** Parse a topology file's `rails` export (absent: none). */
export function parseDeclaredRails(
	exports: Readonly<Record<string, unknown>>,
	options: Readonly<{ stationId: string; source: string }>,
): Readonly<{ ok: true; value: readonly DeclaredRail[] }> | RailRefusal {
	const fallback = exports.default;
	const roots = [
		exports,
		...(isJsonObject(fallback) && fallback.kind !== "yard" ? [fallback] : []),
	];
	try {
		const out: DeclaredRail[] = [];
		for (const root of roots) {
			const rails = root[DECLARED_RAILS_EXPORT];
			if (rails === undefined) continue;
			if (!Array.isArray(rails))
				throw new TypeError(`export ${DECLARED_RAILS_EXPORT} must be an array`);
			rails.forEach((rail, index) => {
				out.push(
					parseRail(
						rail,
						`${options.source}: rails[${index}]`,
						options.stationId,
					),
				);
			});
		}
		return { ok: true, value: out };
	} catch (error) {
		return {
			ok: false,
			code: "cd-topology-invalid",
			message: error instanceof Error ? error.message : String(error),
			remediation: REMEDIATION,
		};
	}
}

export type DeclaredRailCatalog = RailCatalog &
	Readonly<{
		/**
		 * The active Rail's approvedProviders, or undefined when the active Rail
		 * is not a declared one (the journal catalog does not carry them), so
		 * placement fails closed.
		 */
		approvedProviders(stationId: string): Promise<readonly string[] | undefined>;
	}>;

/**
 * The journal's Rails, with declared Rails as each Station's active Rail
 * while its journal has none. Two declared Rails for one Station refuse.
 */
export function declaredRailCatalog(
	journal: RailCatalog,
	declared: readonly DeclaredRail[],
): Outcome<DeclaredRailCatalog> {
	const byStation = new Map<string, DeclaredRail>();
	const byDigest = new Map<string, DeclaredRail>();
	for (const rail of declared) {
		const other = byStation.get(rail.entry.stationId);
		if (other && other.entry.railDigest !== rail.entry.railDigest)
			return {
				ok: false,
				reasons: [
					create(ReasonRecordSchema, {
						code: "cd-rail-conflict",
						message: `Station ${rail.entry.stationId} has two declared Rails (${other.entry.railId}, ${rail.entry.railId})`,
						remediation:
							"Declare one Rail per Station across the topology files you pass.",
						subject: rail.entry.stationId,
					}),
				],
			};
		byStation.set(rail.entry.stationId, rail);
		byDigest.set(rail.entry.railDigest, rail);
	}
	async function active(stationId: string) {
		return (
			(await journal.active(stationId)) ?? byStation.get(stationId)?.entry
		);
	}
	return {
		ok: true,
		value: Object.freeze({
			active,
			async byDigest(railDigest: string) {
				return (
					(await journal.byDigest(railDigest)) ?? byDigest.get(railDigest)?.entry
				);
			},
			async approvedProviders(stationId: string) {
				const rail = await active(stationId);
				return rail ? byDigest.get(rail.railDigest)?.approvedProviders : undefined;
			},
		}),
	};
}

/**
 * Load the `rails` of topology files (`.json` exports objects or modules),
 * through the importer the topology loader used, so a module is evaluated
 * once per command (`memoizedImporter`).
 */
export async function loadDeclaredRails(
	files: readonly string[],
	options: Readonly<{
		cwd: string;
		stationId: string;
		importModule?: ModuleImporter;
	}>,
): Promise<
	Readonly<{ ok: true; value: readonly DeclaredRail[] }> | RailRefusal
> {
	const out: DeclaredRail[] = [];
	for (const file of files) {
		const path = resolve(options.cwd, file);
		let exports: Readonly<Record<string, unknown>>;
		try {
			if (extname(path) === ".json") {
				const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
				if (!isJsonObject(parsed)) continue;
				exports = parsed;
			} else {
				exports = await (options.importModule ?? defaultModuleImporter)(path);
			}
		} catch (error) {
			return {
				ok: false,
				code: "cd-topology-invalid",
				message: `${file}: ${error instanceof Error ? error.message : String(error)}`,
				remediation: REMEDIATION,
			};
		}
		const parsed = parseDeclaredRails(exports, {
			stationId: options.stationId,
			source: file,
		});
		if (!parsed.ok) return parsed;
		out.push(...parsed.value);
	}
	return { ok: true, value: out };
}

/** One evaluation per module path for the life of one command. */
export function memoizedImporter(importer: ModuleImporter): ModuleImporter {
	const loaded = new Map<string, ReturnType<ModuleImporter>>();
	return (path) => {
		let module = loaded.get(path);
		if (!module) {
			module = importer(path);
			loaded.set(path, module);
		}
		return module;
	};
}
