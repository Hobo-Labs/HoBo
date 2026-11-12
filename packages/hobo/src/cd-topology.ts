/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: topology files are untrusted module exports; each record is parsed once with its generated cd_topology schema before it is used. */
/**
 * Declared Camp topology for @hobo/cd (WP18, plan 0024, D19/D20/D22).
 *
 * `TopologyReader` is composed from `@hobo/yards` Yards and their
 * `@hobo/camps` Camps: the Yard's provider and declared regions, the Camp's
 * env type and labels. Residency is evaluated only against these declared
 * regions; observed claims never enter here (I19). A Camp id is Yard-scoped
 * (`<yard>/<camp>`), as placement records it.
 *
 * Several readers (Yards, an imported ClusterProfile inventory) merge into
 * one; a Camp id declared twice is a configuration error, never a silent
 * override.
 */

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fromJson, type JsonValue as ProtoJson } from "@bufbuild/protobuf";
import {
	type CampId,
	CampManagement,
	type CampTopology,
	type TopologyReader,
} from "@hobo/cd";
import { TOPOLOGY_CONTRACT_VERSION, type Yard } from "@hobo/yards";
import {
	type CdTopologyCamp,
	CdTopologyCampSchema,
	type CdTopologyYard,
	CdTopologyYardSchema,
	CampManagement as DeclaredManagement,
} from "./_generated/cd_topology_pb.js";
import {
	defaultModuleImporter,
	type ModuleImporter,
} from "./cd-delivery-module.js";
import { isJsonObject, isJsonString, type JsonObject } from "./json.js";

// public-contract: the Camp label that declares a Camp OBSERVE_ONLY (D5).
export const CD_MANAGEMENT_LABEL = "hobo.cd/management";

export function campIdOf(yardName: string, campId: string): CampId {
	// SAFETY: the Yard-scoped id placement and the journal use for a Camp.
	return `${yardName}/${campId}` as CampId;
}

// domain-view: the part of a @hobo/yards Yard the topology reads (a Yard, or its parsed CdTopologyYard).
export type DeclaredYard = Readonly<{
	name: string;
	providerId: string;
	regions: readonly string[];
	labels: Readonly<Record<string, string>>;
	camps: readonly Readonly<{
		id: string;
		envType: string;
		labels: Readonly<Record<string, string>>;
	}>[];
}>;

/** Project Yards (and their Camps) as declared CD topology. */
export function yardTopology(
	yards: readonly (Yard | DeclaredYard)[],
	stationId: string,
): readonly CampTopology[] {
	const out: CampTopology[] = [];
	for (const yard of yards) {
		for (const camp of yard.camps) {
			const labels = { ...yard.labels, ...camp.labels };
			out.push(
				Object.freeze({
					campId: campIdOf(yard.name, camp.id),
					yardId: yard.name,
					stationId,
					provider: yard.providerId,
					regions: [...yard.regions],
					envType: camp.envType,
					labels,
					management:
						labels[CD_MANAGEMENT_LABEL] === "observe-only"
							? CampManagement.OBSERVE_ONLY
							: CampManagement.MANAGED,
				}),
			);
		}
	}
	return out.sort((a, b) =>
		a.campId < b.campId ? -1 : a.campId > b.campId ? 1 : 0,
	);
}

export class TopologyConflictError extends Error {
	readonly code = "cd-topology-duplicate-camp";
	readonly remediation =
		"Each Camp id may be declared by exactly one source; rename the Camp or drop it from one Yard/ClusterProfile import.";
	constructor(readonly campId: string) {
		super(
			`cd-topology-duplicate-camp: ${campId} is declared by more than one topology source`,
		);
	}
}

/** A static reader over declared Camps. */
export function staticTopologyReader(
	camps: readonly CampTopology[],
): TopologyReader {
	const byId = new Map<string, CampTopology>();
	for (const camp of camps) {
		if (byId.has(camp.campId)) throw new TopologyConflictError(camp.campId);
		byId.set(camp.campId, camp);
	}
	const all = Object.freeze([...byId.values()]);
	return Object.freeze({
		camps: async () => all,
		camp: async (campId: CampId) => byId.get(campId),
	});
}

/** Merge readers; a Camp declared by two readers refuses (fail closed). */
export function mergeTopologyReaders(
	readers: readonly TopologyReader[],
): TopologyReader {
	async function all(): Promise<readonly CampTopology[]> {
		const seen = new Map<string, CampTopology>();
		for (const reader of readers) {
			for (const camp of await reader.camps()) {
				if (seen.has(camp.campId)) throw new TopologyConflictError(camp.campId);
				seen.set(camp.campId, camp);
			}
		}
		return [...seen.values()].sort((a, b) =>
			a.campId < b.campId ? -1 : a.campId > b.campId ? 1 : 0,
		);
	}
	return Object.freeze({
		camps: all,
		async camp(campId: CampId) {
			return (await all()).find((c) => c.campId === campId);
		},
	});
}

// ── Topology files (`hobo deploy --yard`, HOBO_CD_TOPOLOGY) ─────────────────

// public-contract: the environment variable naming topology files for every CD command.
export const CD_TOPOLOGY_ENV = "HOBO_CD_TOPOLOGY";

export type TopologyRefusal = Readonly<{
	ok: false;
	code:
		| "cd-topology-unreadable"
		| "cd-topology-invalid"
		| "cd-topology-station-mismatch";
	message: string;
	remediation: string;
}>;

export type TopologyOutcome =
	| Readonly<{ ok: true; value: readonly CampTopology[] }>
	| TopologyRefusal;

const INVALID_REMEDIATION =
	"A topology file default-exports a @hobo/yards Yard, or exports `yards` (Yards) and/or `camps` (records with campId `<yard>/<camp>`, yardId, provider, envType, optional regions, labels, stationId, management); see packages/hobo/CD.md.";

function splitFiles(value: unknown): string[] {
	return isJsonString(value)
		? value
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s !== "")
		: [];
}

/** Topology files a CD command loads: HOBO_CD_TOPOLOGY first, then `--yard`. */
export function topologyFilesOf(
	flags: JsonObject,
	env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
	return [...splitFiles(env[CD_TOPOLOGY_ENV]), ...splitFiles(flags.yard)];
}

function managementOf(
	declared: DeclaredManagement,
	labels: Readonly<Record<string, string>>,
): CampManagement {
	if (declared === DeclaredManagement.OBSERVE_ONLY)
		return CampManagement.OBSERVE_ONLY;
	if (declared === DeclaredManagement.MANAGED) return CampManagement.MANAGED;
	return labels[CD_MANAGEMENT_LABEL] === "observe-only"
		? CampManagement.OBSERVE_ONLY
		: CampManagement.MANAGED;
}

class TopologyParseError extends Error {
	constructor(
		readonly code: TopologyRefusal["code"],
		message: string,
	) {
		super(message);
	}
}

function arrayExport(name: string, value: unknown): readonly unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new TopologyParseError(
			"cd-topology-invalid",
			`export ${name} must be an array`,
		);
	return value;
}

function invalid(at: string, error: unknown): TopologyParseError {
	return new TopologyParseError(
		"cd-topology-invalid",
		`${at}: ${error instanceof Error ? error.message : String(error)}`,
	);
}

function parseYard(item: unknown, at: string): CdTopologyYard {
	let parsed: CdTopologyYard;
	try {
		// A Yard carries more than the topology reads (bindings, properties):
		// the generated schema reads its fields and ignores the rest.
		parsed = fromJson(
			CdTopologyYardSchema,
			// SAFETY: a JSON round trip; fromJson parses the result.
			JSON.parse(JSON.stringify(item ?? null)) as ProtoJson,
			{ ignoreUnknownFields: true },
		);
	} catch (error) {
		throw invalid(at, error);
	}
	if (
		parsed.kind !== "yard" ||
		parsed.contract !== TOPOLOGY_CONTRACT_VERSION ||
		parsed.name === "" ||
		parsed.providerId === "" ||
		parsed.camps.some((c) => c.kind !== "camp" || c.id === "")
	)
		throw new TopologyParseError(
			"cd-topology-invalid",
			`${at} is not a @hobo/yards Yard (${TOPOLOGY_CONTRACT_VERSION})`,
		);
	return parsed;
}

function parseCamp(item: unknown, at: string, stationId: string): CampTopology {
	let parsed: CdTopologyCamp;
	try {
		// SAFETY: fromJson parses and rejects anything that is not the schema's JSON form.
		parsed = fromJson(CdTopologyCampSchema, (item ?? null) as ProtoJson);
	} catch (error) {
		throw invalid(at, error);
	}
	const local = parsed.campId.slice(parsed.yardId.length + 1);
	if (
		parsed.yardId === "" ||
		!parsed.campId.startsWith(`${parsed.yardId}/`) ||
		local === "" ||
		parsed.provider === "" ||
		parsed.envType === ""
	)
		throw new TopologyParseError(
			"cd-topology-invalid",
			`${at}: campId must be <yardId>/<camp>, and yardId, provider and envType are required`,
		);
	if (parsed.stationId !== "" && parsed.stationId !== stationId)
		throw new TopologyParseError(
			"cd-topology-station-mismatch",
			`${at}: Camp ${parsed.campId} is declared for Station ${parsed.stationId}, not ${stationId}`,
		);
	const labels = { ...parsed.labels };
	return Object.freeze({
		campId: campIdOf(parsed.yardId, local),
		yardId: parsed.yardId,
		stationId,
		provider: parsed.provider,
		regions: [...parsed.regions],
		envType: parsed.envType,
		labels,
		management: managementOf(parsed.management, labels),
	});
}

/** Parse a topology file's exports once with the generated schemas. */
export function parseTopologyExports(
	exports: Readonly<Record<string, unknown>>,
	options: Readonly<{ stationId: string; source: string }>,
): TopologyOutcome {
	const yards: unknown[] = [];
	const camps: unknown[] = [];
	const fallback = exports.default;
	const roots: Readonly<Record<string, unknown>>[] = [exports];
	if (isJsonObject(fallback)) {
		if (fallback.kind === "yard") yards.push(fallback);
		else roots.push(fallback);
	}
	try {
		for (const root of roots) {
			yards.push(...arrayExport("yards", root.yards));
			camps.push(...arrayExport("camps", root.camps));
		}
		const declared = yards.map((yard, i) =>
			parseYard(yard, `${options.source}: yards[${i}]`),
		);
		return {
			ok: true,
			value: [
				...yardTopology(declared, options.stationId),
				...camps.map((camp, i) =>
					parseCamp(camp, `${options.source}: camps[${i}]`, options.stationId),
				),
			],
		};
	} catch (error) {
		if (!(error instanceof TopologyParseError)) throw error;
		return {
			ok: false,
			code: error.code,
			message: error.message,
			remediation:
				error.code === "cd-topology-station-mismatch"
					? "Declare the Camp for this Station (HOBO_STATION), or leave stationId empty."
					: INVALID_REMEDIATION,
		};
	}
}

/**
 * Load topology files: `.json` (an exports object) or a module (a Yard module
 * such as packages/ci-vercel/deploy/yard.ts, or a delivery module exporting
 * `yards`/`camps`). Other exports of a module are not topology and are left
 * to their own readers. Any refusal refuses the whole set.
 */
export async function loadTopologyFiles(
	files: readonly string[],
	options: Readonly<{
		cwd: string;
		stationId: string;
		importModule?: ModuleImporter;
	}>,
): Promise<TopologyOutcome> {
	const out: CampTopology[] = [];
	for (const file of files) {
		const path = resolve(options.cwd, file);
		let exports: Readonly<Record<string, unknown>>;
		try {
			if (extname(path) === ".json") {
				const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
				if (!isJsonObject(parsed))
					return {
						ok: false,
						code: "cd-topology-invalid",
						message: `${file} must hold a JSON object`,
						remediation: INVALID_REMEDIATION,
					};
				exports = parsed;
			} else {
				exports = await (options.importModule ?? defaultModuleImporter)(path);
			}
		} catch (error) {
			return {
				ok: false,
				code: "cd-topology-unreadable",
				message: `${file}: ${error instanceof Error ? error.message : String(error)}`,
				remediation:
					"Check the path (relative to --cwd) and that the module loads with `node --import tsx`.",
			};
		}
		const parsed = parseTopologyExports(exports, {
			stationId: options.stationId,
			source: file,
		});
		if (!parsed.ok) return parsed;
		out.push(...parsed.value);
	}
	return { ok: true, value: out };
}
