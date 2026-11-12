/**
 * `ConfigStore`, the Durable Object that holds the store. One instance per
 * account (`idFromName("store")`), SQLite-backed (the only backend the
 * Workers Free plan offers), private to the account: nothing reaches it but
 * this Worker, which authenticates every caller before forwarding.
 *
 * Storage keys:
 * - `folder:relay`, `folder:deploy`: `{ entries, version }`;
 * - `meta:bootstrap`: present once the bootstrap credential is burned;
 * - `meta:audit-next`, `audit:<seq>`: the audit log, names only, the last
 *   `LIMITS.auditEntries` kept.
 *
 * Concurrency: a Durable Object delivers no other event while a storage
 * operation runs, so each handler does any non-storage await (hashing)
 * first and then reads and writes with nothing in between; the bootstrap is
 * burned in the same `put` that writes the seed, so two racing seeds cannot
 * both pass.
 */
import { constantTimeEqual, sha256Hex } from "./bytes.js";
import { failure, json } from "./http.js";
import {
	field,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import {
	type EntryMap,
	FOLDERS,
	type Folder,
	LIMITS,
	parseFolder,
	parseSeed,
	parseWorkerBinding,
	parseWrite,
	type WorkerBinding,
} from "./records.js";

/** The slice of `DurableObjectStorage` the store uses. */
export type StoragePort = Readonly<{
	get(key: string): Promise<JsonValue | undefined>;
	put(entries: Readonly<Record<string, JsonValue>>): Promise<void>;
	delete(keys: readonly string[]): Promise<number>;
	list(prefix: string): Promise<ReadonlyMap<string, JsonValue>>;
}>;

/**
 * `DurableObjectState`, as far as the store uses it. Typed in JSON values:
 * the store writes nothing else under its keys, and storage returns
 * structured clones of what was written.
 */
export type DurableObjectStateLike = Readonly<{
	storage: Readonly<{
		get(key: string): Promise<JsonValue | undefined>;
		put(entries: Record<string, JsonValue>): Promise<void>;
		delete(keys: string[]): Promise<number>;
		list(options: { prefix: string }): Promise<Map<string, JsonValue>>;
	}>;
}>;

export type ConfigStoreEnv = Readonly<{ HOBO_CONFIG_BINDING?: string }>;

// The Worker addresses the store with these; nothing outside the Worker can.
// public-contract: the internal origin of the Worker → Durable Object hop.
export const INTERNAL_ORIGIN = "https://config-store.internal";
// public-contract: the header carrying the principal the Worker authenticated.
export const PRINCIPAL_HEADER = "x-hobo-principal";
// public-contract: the header carrying the bootstrap credential to the store.
export const BOOTSTRAP_HEADER = "x-hobo-bootstrap";

/** A caller the Worker authenticated with a verified OIDC token. */
export type Principal = "vercel-relay" | "github-deploy" | "owner";
export type WriterPrincipal = Exclude<Principal, "vercel-relay">;
type AuditPrincipal = Principal | "bootstrap";

function principalOf(value: string | null): Principal | undefined {
	return value === "vercel-relay" ||
		value === "github-deploy" ||
		value === "owner"
		? value
		: undefined;
}

type FolderState = Readonly<{ entries: EntryMap; version: number }>;

function storagePort(state: DurableObjectStateLike): StoragePort {
	return Object.freeze({
		get: (key: string) => state.storage.get(key),
		put: (entries: Readonly<Record<string, JsonValue>>) =>
			state.storage.put({ ...entries }),
		delete: (keys: readonly string[]) => state.storage.delete([...keys]),
		list: (prefix: string) => state.storage.list({ prefix }),
	});
}

function folderState(value: JsonValue | undefined): FolderState {
	if (!isJsonObject(value)) return { entries: {}, version: 0 };
	const entries = field(value, "entries");
	const version = field(value, "version");
	const out: Record<string, string> = {};
	if (isJsonObject(entries))
		for (const [name, entry] of Object.entries(entries))
			if (isJsonString(entry)) out[name] = entry;
	return { entries: out, version: isJsonNumber(version) ? version : 0 };
}

function folderRecord(state: FolderState): JsonObject {
	return { entries: { ...state.entries }, version: state.version };
}

function auditKey(seq: number): string {
	return `audit:${String(seq).padStart(12, "0")}`;
}

/** Audit rows and the next sequence number, to go in the caller's `put`. */
async function auditRows(
	storage: StoragePort,
	at: number,
	rows: readonly Readonly<{
		principal: AuditPrincipal;
		action: "seed" | "write" | "denied";
		folder: Folder;
		names: readonly string[];
	}>[],
): Promise<{
	readonly put: Record<string, JsonValue>;
	readonly drop: string[];
}> {
	const next = await storage.get("meta:audit-next");
	let seq = isJsonNumber(next) ? next : 0;
	const put: Record<string, JsonValue> = {};
	const drop: string[] = [];
	for (const row of rows) {
		put[auditKey(seq)] = {
			at: new Date(at).toISOString(),
			principal: row.principal,
			action: row.action,
			folder: row.folder,
			names: [...row.names].sort(),
		};
		if (seq >= LIMITS.auditEntries)
			drop.push(auditKey(seq - LIMITS.auditEntries));
		seq += 1;
	}
	put["meta:audit-next"] = seq;
	return { put, drop };
}

export type ConfigStoreCore = Readonly<{
	handle(request: Request): Promise<Response>;
}>;

/** The store's logic over a storage port; the Durable Object class wraps it. */
export function createConfigStoreCore(
	storage: StoragePort,
	binding: WorkerBinding | undefined,
	now: () => number,
): ConfigStoreCore {
	async function read(folder: Folder): Promise<Response> {
		const state = folderState(await storage.get(`folder:${folder}`));
		return json(200, {
			folder,
			entries: { ...state.entries },
			version: state.version,
		});
	}

	async function write(
		folder: Folder,
		principal: WriterPrincipal,
		body: string,
	): Promise<Response> {
		const change = parseWrite(body);
		if (change === undefined) return failure("BODY_REJECTED");
		const at = now();
		const audit = await auditRows(storage, at, [
			{
				principal,
				action: "write",
				folder,
				names: [...Object.keys(change.entries), ...change.delete],
			},
		]);
		const current = folderState(await storage.get(`folder:${folder}`));
		const entries = { ...current.entries, ...change.entries };
		for (const name of change.delete) delete entries[name];
		if (Object.keys(entries).length > LIMITS.entriesPerFolder)
			return failure("FOLDER_FULL");
		const next: FolderState = { entries, version: current.version + 1 };
		await storage.put({
			...audit.put,
			[`folder:${folder}`]: folderRecord(next),
		});
		if (audit.drop.length > 0) await storage.delete(audit.drop);
		return json(200, {
			folder,
			names: [...Object.keys(change.entries), ...change.delete].sort(),
			version: next.version,
		});
	}

	async function seed(credential: string, body: string): Promise<Response> {
		if (binding === undefined) return failure("STORE_UNCONFIGURED");
		// Hash before touching storage: nothing else may run between the
		// burn check below and the put that burns.
		const presented =
			credential.length > 0 && credential.length <= LIMITS.tokenBytes
				? await sha256Hex(credential)
				: "";
		const at = now();
		const matches = constantTimeEqual(presented, binding.bootstrapSha256);
		const burned = (await storage.get("meta:bootstrap")) !== undefined;
		if (!matches || burned || at >= binding.bootstrapExpiresAtMs)
			return failure("BOOTSTRAP_REFUSED");
		const parsed = parseSeed(body);
		if (parsed === undefined) return failure("BODY_REJECTED");
		const audit = await auditRows(
			storage,
			at,
			FOLDERS.map((folder) => ({
				principal: "bootstrap",
				action: "seed",
				folder,
				names: Object.keys(parsed[folder]),
			})),
		);
		const records: Record<string, JsonValue> = {};
		for (const folder of FOLDERS)
			records[`folder:${folder}`] = folderRecord({
				entries: parsed[folder],
				version: 1,
			});
		// One put: the burn and the seed land together or not at all.
		await storage.put({
			...audit.put,
			...records,
			"meta:bootstrap": { burnedAt: new Date(at).toISOString() },
		});
		return json(200, {
			folders: FOLDERS.map((folder) => ({
				folder,
				names: Object.keys(parsed[folder]).sort(),
				version: 1,
			})),
		});
	}

	async function denied(
		folder: Folder,
		principal: Principal,
	): Promise<Response> {
		const audit = await auditRows(storage, now(), [
			{ principal, action: "denied", folder, names: [] },
		]);
		await storage.put(audit.put);
		if (audit.drop.length > 0) await storage.delete(audit.drop);
		return failure("FORBIDDEN");
	}

	async function auditLog(): Promise<Response> {
		const rows = await storage.list("audit:");
		return json(200, { entries: [...rows.values()] });
	}

	return Object.freeze({
		async handle(request) {
			// The Worker's internal routes: `GET /folder/<f>`, `PATCH /folder/<f>`,
			// `POST /denied/<f>`, `POST /seed`, `GET /audit`.
			const [, area, name] = new URL(request.url).pathname.split("/");
			const operation = `${request.method} ${area ?? ""}`;
			if (operation === "POST seed")
				return seed(
					request.headers.get(BOOTSTRAP_HEADER) ?? "",
					await request.text(),
				);
			if (operation === "GET audit") return auditLog();
			const folder = parseFolder(name ?? "");
			if (folder === undefined) return failure("NOT_FOUND");
			if (operation === "GET folder") return read(folder);
			const principal = principalOf(request.headers.get(PRINCIPAL_HEADER));
			if (principal === undefined) return failure("FORBIDDEN");
			if (operation === "POST denied") return denied(folder, principal);
			if (operation === "PATCH folder" && principal !== "vercel-relay")
				return write(folder, principal, await request.text());
			return failure("NOT_FOUND");
		},
	});
}

/**
 * The Durable Object class the Worker's migration creates
 * (`new_sqlite_classes: ["ConfigStore"]`). Constructed by the runtime.
 */
export class ConfigStore {
	readonly #core: ConfigStoreCore;
	constructor(state: DurableObjectStateLike, env: ConfigStoreEnv) {
		this.#core = createConfigStoreCore(
			storagePort(state),
			parseWorkerBinding(env.HOBO_CONFIG_BINDING),
			Date.now,
		);
	}
	fetch(request: Request): Promise<Response> {
		return this.#core.handle(request);
	}
}
