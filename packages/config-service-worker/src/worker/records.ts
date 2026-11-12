/**
 * The Worker's parsers: the deploy-time binding, the owner's Access
 * variable, and request bodies. Each crosses one parser and becomes a frozen
 * derived value; the handlers accept only those. The constraints are the CUE
 * ones in `data-models/config_service_worker.cue`.
 *
 * Types are narrowings of the generated protobuf records, imported as types
 * only, so the uploaded modules carry no runtime dependency.
 */
import type {
	ConfigServiceOwnerAccess,
	GithubOidcWriter,
	VercelOidcReader,
} from "../_generated/config_service_worker_pb.js";
import { utf8Length } from "./bytes.js";
import {
	field,
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	jsonObject,
	matching,
} from "./json.js";

type Plain<T> = Readonly<Omit<T, "$typeName" | "$unknown">>;

// public-contract: the two folders a store holds; the relay reads one, the deploy workflow the other.
export const FOLDERS = ["relay", "deploy"] as const;
export type Folder = (typeof FOLDERS)[number];

export const LIMITS = Object.freeze({
	/** A request body, seed included. */
	bodyBytes: 65_536,
	/** One entry's value, in UTF-8 bytes. */
	valueBytes: 16_384,
	/** Entries in one folder. */
	entriesPerFolder: 64,
	/** A bearer token or a credential. */
	tokenBytes: 8_192,
	/** Audit entries kept; the oldest are dropped. */
	auditEntries: 500,
});

const ENTRY_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const STORE_ID = /^[a-z0-9]{16,32}$/u;
const VERCEL_ISSUER =
	/^https:\/\/oidc\.vercel\.com\/([a-z0-9][a-z0-9-]{0,99})$/u;

declare const parsedBrand: unique symbol;
export type Parsed<T, Name extends string> = T & {
	readonly [parsedBrand]: Name;
};

/** Brand a value its parser has just checked. */
function parsed<T, Name extends string>(value: T): Parsed<T, Name> {
	// SAFETY: every caller has checked `value` against the constraints of `Name`.
	return Object.freeze(value) as Parsed<T, Name>;
}

export type WorkerBinding = Parsed<
	Readonly<{
		storeId: string;
		relay: Plain<VercelOidcReader>;
		deploy: Plain<GithubOidcWriter>;
		bootstrapSha256: string;
		bootstrapExpiresAtMs: number;
	}>,
	"WorkerBinding"
>;

export type OwnerAccess = Parsed<
	Plain<ConfigServiceOwnerAccess>,
	"OwnerAccess"
>;

function object(
	source: JsonObject | undefined,
	key: "relay" | "deploy",
): JsonObject | undefined {
	const value = field(source, key);
	return isJsonObject(value) ? value : undefined;
}

function vercelReader(
	source: JsonObject | undefined,
): Plain<VercelOidcReader> | undefined {
	const issuer = matching(source, "issuer", VERCEL_ISSUER);
	const team =
		issuer === undefined ? undefined : VERCEL_ISSUER.exec(issuer)?.[1];
	const audience = matching(
		source,
		"audience",
		/^https:\/\/vercel\.com\/[a-z0-9][a-z0-9-]{0,99}$/u,
	);
	const subject = matching(
		source,
		"subject",
		/^owner:[a-z0-9-]+:project:[A-Za-z0-9._-]+:environment:[a-z0-9-]+$/u,
	);
	const ownerId = matching(source, "ownerId", /^team_[A-Za-z0-9]{1,64}$/u);
	const projectId = matching(source, "projectId", /^prj_[A-Za-z0-9]{1,64}$/u);
	const environment = matching(
		source,
		"environment",
		/^[a-z0-9][a-z0-9-]{0,63}$/u,
	);
	if (
		issuer === undefined ||
		team === undefined ||
		audience === undefined ||
		subject === undefined ||
		ownerId === undefined ||
		projectId === undefined ||
		environment === undefined ||
		// The audience and the subject name the issuer's team and environment.
		audience !== `https://vercel.com/${team}` ||
		!subject.startsWith(`owner:${team}:project:`) ||
		!subject.endsWith(`:environment:${environment}`)
	)
		return undefined;
	return Object.freeze({
		issuer,
		audience,
		subject,
		ownerId,
		projectId,
		environment,
	});
}

function githubWriter(
	source: JsonObject | undefined,
	storeId: string,
): Plain<GithubOidcWriter> | undefined {
	const issuer = matching(
		source,
		"issuer",
		/^https:\/\/token\.actions\.githubusercontent\.com$/u,
	);
	const audience = matching(
		source,
		"audience",
		/^urn:hobo:config-service:[a-z0-9]{16,32}$/u,
	);
	const repository = matching(
		source,
		"repository",
		/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u,
	);
	const ref = matching(source, "ref", /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/u);
	const rawId = field(source, "repositoryId");
	const repositoryId =
		rawId === undefined || rawId === ""
			? ""
			: matching(source, "repositoryId", /^[0-9]{1,20}$/u);
	if (
		issuer === undefined ||
		repository === undefined ||
		ref === undefined ||
		repositoryId === undefined ||
		// The audience names this store, so a token minted for another is refused.
		audience !== `urn:hobo:config-service:${storeId}`
	)
		return undefined;
	return Object.freeze({ issuer, audience, repository, ref, repositoryId });
}

/**
 * `HOBO_CONFIG_BINDING`, as `ConfigServiceWorkerBinding` JSON. Undefined when
 * it is absent or does not meet its constraints: the Worker then answers
 * every route but health with `STORE_UNCONFIGURED` (fail closed).
 */
export function parseWorkerBinding(
	raw: string | undefined,
): WorkerBinding | undefined {
	const record = jsonObject(raw);
	const storeId = matching(record, "storeId", STORE_ID);
	if (storeId === undefined) return undefined;
	const relay = vercelReader(object(record, "relay"));
	const deploy = githubWriter(object(record, "deploy"), storeId);
	const bootstrapSha256 = matching(
		record,
		"bootstrapSha256",
		/^[0-9a-f]{64}$/u,
	);
	const expires = matching(
		record,
		"bootstrapExpiresAt",
		/^\d{4}-\d{2}-\d{2}T/u,
	);
	const bootstrapExpiresAtMs =
		expires === undefined ? Number.NaN : Date.parse(expires);
	if (
		relay === undefined ||
		deploy === undefined ||
		bootstrapSha256 === undefined ||
		!Number.isFinite(bootstrapExpiresAtMs)
	)
		return undefined;
	return parsed({
		storeId,
		relay,
		deploy,
		bootstrapSha256,
		bootstrapExpiresAtMs,
	});
}

/** `HOBO_CONFIG_OWNER_ACCESS`: absent until the owner sets it after the claim. */
export function parseOwnerAccess(
	raw: string | undefined,
): OwnerAccess | undefined {
	const record = jsonObject(raw);
	const issuer = matching(
		record,
		"issuer",
		/^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/u,
	);
	const audience = matching(record, "audience", /^[A-Za-z0-9]{16,128}$/u);
	if (issuer === undefined || audience === undefined) return undefined;
	return parsed({ issuer, audience });
}

export function parseFolder(value: string): Folder | undefined {
	return FOLDERS.find((folder) => folder === value);
}

export type EntryMap = Readonly<Record<string, string>>;

/** Entries that meet the constraints, or undefined. Never echoes a value. */
function parseEntries(source: JsonObject | undefined): EntryMap | undefined {
	if (source === undefined) return Object.freeze({});
	const names = Object.keys(source);
	if (names.length > LIMITS.entriesPerFolder) return undefined;
	const out: Record<string, string> = {};
	for (const name of names) {
		const entry = source[name];
		if (
			!ENTRY_NAME.test(name) ||
			!isJsonString(entry) ||
			entry.includes("\u0000") ||
			utf8Length(entry) > LIMITS.valueBytes
		)
			return undefined;
		out[name] = entry;
	}
	return Object.freeze(out);
}

function entriesOf(source: JsonObject | undefined): EntryMap | undefined {
	const value = field(source, "entries");
	if (value === undefined) return Object.freeze({});
	return isJsonObject(value) ? parseEntries(value) : undefined;
}

export type ParsedSeed = Parsed<
	Readonly<Record<Folder, EntryMap>>,
	"ParsedSeed"
>;

/** `ConfigServiceSeed` JSON. Folders not named are seeded empty. */
export function parseSeed(body: string): ParsedSeed | undefined {
	const raw = field(jsonObject(body), "folders");
	if (!isJsonObject(raw)) return undefined;
	if (Object.keys(raw).some((name) => parseFolder(name) === undefined))
		return undefined;
	const folder = (name: Folder) => {
		const value = field(raw, name);
		if (value === undefined) return Object.freeze({});
		return isJsonObject(value) ? entriesOf(value) : undefined;
	};
	const relay = folder("relay");
	const deploy = folder("deploy");
	if (relay === undefined || deploy === undefined) return undefined;
	return parsed({ relay, deploy });
}

export type ParsedWrite = Parsed<
	Readonly<{ entries: EntryMap; delete: readonly string[] }>,
	"ParsedWrite"
>;

/** `ConfigFolderWrite` JSON: at least one change, no name both set and deleted. */
export function parseWrite(body: string): ParsedWrite | undefined {
	const record = jsonObject(body);
	if (record === undefined) return undefined;
	const entries = entriesOf(record);
	const rawDelete = field(record, "delete") ?? [];
	if (entries === undefined || !isJsonArray(rawDelete)) return undefined;
	const names: string[] = [];
	for (const name of rawDelete) {
		if (!isJsonString(name) || !ENTRY_NAME.test(name)) return undefined;
		if (!names.includes(name)) names.push(name);
	}
	if (
		names.length > LIMITS.entriesPerFolder ||
		Object.keys(entries).length + names.length === 0 ||
		names.some((name) => Object.hasOwn(entries, name))
	)
		return undefined;
	return parsed({ entries, delete: Object.freeze(names) });
}
