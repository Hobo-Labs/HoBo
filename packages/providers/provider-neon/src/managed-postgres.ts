/** Account-owned Neon PostgreSQL, scoped to an approved organization. */
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { parseSecretRef } from "@hobo/bindings";
import type {
	ProfileImplementation,
	SelectionCandidate,
} from "@hobo/capability-profiles";
import {
	type ClaimableOperationKeyDeriver,
	type ClaimableResolverScope,
	claimableOperationKey,
	claimableResourceRef,
	guardTransport,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceMutationJournal,
	type ResourceResolver,
	slotBinding,
} from "@hobo/core";
import pg from "pg";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonObject,
} from "./json.js";

// public-contract: stable product identity shared by SDK declarations and provider bindings.
export const NEON_MANAGED_POSTGRES_PRODUCT_ID = "neon.managed-postgres/v1";

/** Registration is not evidence of a funded account or a healthy database. */
export function createNeonManagedPostgresCandidate(
	input: {
		readonly evidenceSignatureValid?: boolean;
		readonly evidenceExpiresAtMs?: number;
		readonly secretCustodyAvailable?: boolean;
		readonly conformance?: ProfileImplementation["conformance"];
	} = {},
): SelectionCandidate {
	return {
		definitionId: NEON_MANAGED_POSTGRES_PRODUCT_ID,
		providerId: "neon",
		implementsProfiles: [
			{
				profileId: "data.postgres/v1",
				versionRange: ">=1",
				realization: "native",
				conformanceRef: "hobo.conformance/data.postgres/v1#neon.direct-session",
				conformance: input.conformance ?? "unknown",
			},
		],
		runtimeModels: ["oci", "vm_iaas", "paas", "serverless_faas"],
		structuredCapabilities: {
			postgresWireProtocol: true,
			tls: true,
			transactions: true,
			pooling: false,
			bootstrap: "authenticated-account",
		},
		// The API-created owner cannot be issued to a runtime voter. A separate
		// restricted-role enrollment must be installed before publishing a binding.
		producesBindingProfiles: [],
		migrationProfiles: ["migration.postgres.pg-dump/v1"],
		providerClass: "verified-emerging",
		evidenceExpiresAtMs: input.evidenceExpiresAtMs ?? 0,
		evidenceSignatureValid: input.evidenceSignatureValid ?? false,
		creatorAuthorityAfterClaim: "absent",
		claimAtomicity: "single-resource",
		claimActionCount: 0,
		continuity: {
			endpoint: "not-applicable",
			data: "not-applicable",
			credentials: "not-applicable",
		},
		supportsExport: true,
		supportsRotation: false,
		supportsRevocation: false,
		sponsorExposureMinorUnits: 0,
		// Management-only today: selection must wait for the restricted runtime
		// role and its independently verified Junction binding.
		hasRegisteredDriver: false,
		secretCustodyAvailable: input.secretCustodyAvailable ?? false,
	};
}

/** Every limit must be positive: Neon interprets zero as unlimited. */
export interface NeonManagedQuota {
	readonly activeTimeSeconds: number;
	readonly computeTimeSeconds: number;
	readonly dataTransferBytes: number;
	readonly logicalSizeBytes: number;
	readonly writtenDataBytes: number;
}

export interface NeonManagedProjectIdentity {
	readonly projectId: string;
	readonly branchId: string;
	readonly endpointId: string;
}

/** The record is immutable and may only be written after the exact create
 * response has been received. It binds a private operation to native IDs. */
export interface NeonManagedProjectRepository {
	readonly persistence: "durable-cas";
	read(key: string): Promise<NeonManagedProjectIdentity | undefined>;
	create(key: string, identity: NeonManagedProjectIdentity): Promise<void>;
}

export interface NeonManagedAuthorization {
	readonly tenantId: string;
	readonly providerAccountId: string;
	readonly scopeId: string;
	readonly logicalId: string;
	readonly operation: "read" | "create";
	readonly desiredDigest: string;
	readonly budgetId: string;
	readonly quoteRef: string;
	readonly permissionEvidenceRef: string;
	readonly quotaEvidenceRef: string;
	readonly observedAtMs: number;
	readonly expiresAtMs: number;
}

export interface NeonManagedPostgresOptions {
	readonly scope: ClaimableResolverScope;
	readonly deriveOperationKey: ClaimableOperationKeyDeriver;
	readonly journal: ResourceMutationJournal & {
		inspect(input: {
			readonly mutationId: string;
			readonly requestDigest: string;
		}): Promise<{ readonly status: "missing" | "acknowledged" | "uncertain" }>;
	};
	readonly repository: NeonManagedProjectRepository;
	readonly resolveCredential: (
		ref: string,
	) => Promise<{ readonly accountId: string; readonly token: string }>;
	readonly custody: {
		read(
			key: string,
		): Promise<{ readonly ref: string; readonly value: string } | undefined>;
		/** Create-only; a conflicting value must never be overwritten. */
		create(key: string, value: string): Promise<void>;
	};
	/** Supplied by the authenticated host after checking its actual Broker hold,
	 * current provider permission and account-specific quota/price evidence. */
	readonly authorize: (input: {
		readonly scope: ClaimableResolverScope;
		readonly request: ResolveRequest;
		readonly operation: "read" | "create";
		readonly desiredDigest: string;
	}) => Promise<NeonManagedAuthorization>;
	/** The supervisor checks its current actor, placement and funded operation. */
	readonly revalidateBeforeWrite: () => Promise<void>;
	readonly clock: () => number;
	/** Tests may replace the network probe; production uses real TLS and LISTEN. */
	readonly probeSession?: (input: NeonManagedSession) => Promise<void>;
}

export interface NeonManagedSession {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly username: string;
	readonly password: string;
}

type ChannelBindingClient = pg.Client & {
	readonly enableChannelBinding: boolean;
};
type AuthenticationSaslEvent = Readonly<{ mechanisms?: readonly string[] }>;

const ORG = /^org-[a-z0-9-]{1,124}$/u;
const NATIVE = /^[a-z0-9][a-z0-9-]{0,126}$/u;
const REGION = /^aws-[a-z0-9-]{1,80}$/u;
const QUOTA_FIELDS = [
	"activeTimeSeconds",
	"computeTimeSeconds",
	"dataTransferBytes",
	"logicalSizeBytes",
	"writtenDataBytes",
] as const;
const WIRE_QUOTA_FIELDS = [
	"active_time_seconds",
	"compute_time_seconds",
	"data_transfer_bytes",
	"logical_size_bytes",
	"written_data_bytes",
] as const;

function refuse(message: string): never {
	throw new ResolverError("RESOLVER_PROVIDER_REJECTED", message);
}
function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function quota(value: JsonObject | undefined): NeonManagedQuota {
	if (
		!value ||
		Object.keys(value).sort().join(",") !== [...QUOTA_FIELDS].sort().join(",")
	)
		return refuse("Neon requires every finite provider quota");
	for (const field of QUOTA_FIELDS) {
		const number = value[field];
		if (!isJsonNumber(number) || !Number.isSafeInteger(number) || number <= 0)
			return refuse("Neon requires every finite provider quota");
	}
	return {
		activeTimeSeconds: Number(value.activeTimeSeconds),
		computeTimeSeconds: Number(value.computeTimeSeconds),
		dataTransferBytes: Number(value.dataTransferBytes),
		logicalSizeBytes: Number(value.logicalSizeBytes),
		writtenDataBytes: Number(value.writtenDataBytes),
	};
}
function wireQuota(value: NeonManagedQuota): Record<string, number> {
	return Object.fromEntries(
		QUOTA_FIELDS.map((field, index) => [
			WIRE_QUOTA_FIELDS[index],
			value[field],
		]),
	);
}
function checkedTime(clock: () => number): number {
	const now = clock();
	if (!Number.isSafeInteger(now) || now < 1)
		throw new Error("Neon clock is invalid");
	return now;
}
function validIdentity(value: NeonManagedProjectIdentity): boolean {
	return (
		isJsonString(value.projectId) &&
		isJsonString(value.branchId) &&
		isJsonString(value.endpointId) &&
		NATIVE.test(value.projectId) &&
		value.branchId.length <= 127 &&
		value.endpointId.length <= 127 &&
		/^br-[a-z0-9-]+$/u.test(value.branchId) &&
		/^ep-[a-z0-9-]+$/u.test(value.endpointId)
	);
}

/** SDK declaration only; account access, quotes and capacity are separate. */
export function neonManagedPostgres(input: {
	readonly organizationId: string;
	readonly region: string;
	readonly quota: NeonManagedQuota;
}) {
	if (!ORG.test(input.organizationId) || !REGION.test(input.region))
		throw new Error(
			"Neon managed PostgreSQL needs an explicit organization and AWS region",
		);
	const limits = quota({ ...input.quota });
	return slotBinding({
		slot: "data",
		profile: "data.postgres/v1",
		productId: NEON_MANAGED_POSTGRES_PRODUCT_ID,
		properties: {
			organizationId: input.organizationId,
			region: input.region,
			quota: { ...limits },
		},
	});
}

/** Direct sessions support LISTEN; Neon transaction pooling does not. */
export async function probeNeonManagedSession(
	input: NeonManagedSession,
): Promise<void> {
	let offeredPlus = false;
	let completedPlus = false;
	let rejectedAuthentication = false;
	const config = {
		host: input.host,
		port: input.port,
		database: input.database,
		user: input.username,
		// node-postgres otherwise treats channel binding as opportunistic. Never
		// release the credential unless this exact TLS session offered SCRAM-PLUS.
		password: () => {
			if (!offeredPlus || rejectedAuthentication)
				throw new Error("required channel binding unavailable");
			return input.password;
		},
		ssl: { rejectUnauthorized: true },
		enableChannelBinding: true,
		connectionTimeoutMillis: 5_000,
		query_timeout: 5_000,
	};
	const client = new pg.Client(config);
	// The driver's connection event comes before its authentication handler.
	// The exact pinned pg version selects PLUS first when enabled.
	const rejectAuthentication = () => {
		rejectedAuthentication = true;
		client.connection.stream.destroy(
			new Error("required channel binding unavailable"),
		);
	};
	client.connection.prependListener(
		"authenticationSASL",
		(message: AuthenticationSaslEvent) => {
			const mechanisms = message.mechanisms;
			if (
				offeredPlus ||
				!Array.isArray(mechanisms) ||
				!mechanisms.includes("SCRAM-SHA-256-PLUS")
			) {
				rejectAuthentication();
				return;
			}
			offeredPlus = true;
		},
	);
	client.connection.prependListener("authenticationSASLFinal", () => {
		completedPlus = offeredPlus && !rejectedAuthentication;
	});
	client.connection.prependListener(
		"authenticationCleartextPassword",
		rejectAuthentication,
	);
	client.connection.prependListener(
		"authenticationMD5Password",
		rejectAuthentication,
	);
	try {
		// SAFETY: the pinned pg 8.22.0 client exposes the configured boolean;
		// the following check refuses a changed or unsupported driver.
		const channelBindingClient = client as ChannelBindingClient;
		if (channelBindingClient.enableChannelBinding !== true)
			throw new Error("channel binding is not supported by the driver");
		await client.connect();
		if (!completedPlus || rejectedAuthentication)
			throw new Error("channel binding was not authenticated");
		const result = await client.query(
			"SELECT current_database() AS database, current_user AS username, NOT pg_is_in_recovery() AS primary, current_setting('transaction_read_only') = 'off' AS read_write, has_database_privilege(current_user, current_database(), 'CREATE') AS can_create, current_setting('server_version_num')::int AS version",
		);
		const row = result.rows[0];
		if (
			row?.database !== input.database ||
			row?.username !== input.username ||
			row?.primary !== true ||
			row?.read_write !== true ||
			row?.can_create !== true ||
			!Number.isInteger(row?.version) ||
			row.version < 160000
		)
			throw new Error("wrong database identity");
		const channel = `hobo_probe_${randomBytes(12).toString("hex")}`;
		const nonce = randomBytes(16).toString("hex");
		await client.query(`LISTEN "${channel}"`);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let listener:
			| ((message: { channel: string; payload?: string | undefined }) => void)
			| undefined;
		const notification = new Promise<void>((resolve, reject) => {
			listener = (message) => {
				if (message.channel === channel && message.payload === nonce) resolve();
			};
			client.on("notification", listener);
			timeout = setTimeout(
				() => reject(new Error("notification timed out")),
				5_000,
			);
		});
		void notification.catch(() => {});
		try {
			await client.query("SELECT pg_notify($1, $2)", [channel, nonce]);
			await notification;
			await client.query(`UNLISTEN "${channel}"`);
		} finally {
			if (timeout) clearTimeout(timeout);
			if (listener) client.off("notification", listener);
		}
	} catch {
		return refuse("Neon direct PostgreSQL session could not be verified");
	} finally {
		await client.end().catch(() => {});
	}
}

/** Metadata only: never creates, opens a database session, or reads a secret
 * from the provider. Account plan and inventory do not prove usable quota. */
export async function observeNeonManagedPreflight(input: {
	readonly providerAccountId: string;
	readonly credentialRef: string;
	readonly resolveCredential: NeonManagedPostgresOptions["resolveCredential"];
	readonly transport: HttpTransport;
	readonly clock: () => number;
}) {
	if (!ORG.test(input.providerAccountId))
		return refuse("Neon account scope is invalid");
	parseSecretRef(input.credentialRef);
	const call = await neonCaller(
		input.providerAccountId,
		input.credentialRef,
		input.resolveCredential,
		input.transport,
	);
	const org = await call(
		"GET",
		`/api/v2/organizations/${encodeURIComponent(input.providerAccountId)}`,
	);
	if (org.status !== 200) return refuse("Neon organization is unavailable");
	const body = parseJsonObject(org.body);
	if (body.id !== input.providerAccountId || !isJsonString(body.plan))
		return refuse("Neon organization differs from the approved account");
	const rows = await listProjects(call, input.providerAccountId);
	const observedAtMs = checkedTime(input.clock);
	if (!Number.isSafeInteger(observedAtMs + 300_000))
		return refuse("Neon preflight clock is invalid");
	return Object.freeze({
		providerAccountId: input.providerAccountId,
		plan: body.plan,
		activeProjectCount: rows.length,
		createPermission: "not-observed" as const,
		remainingCapacity: "not-observed" as const,
		quotedCost: "not-observed" as const,
		databaseSession: "not-observed" as const,
		observedAtMs,
		expiresAtMs: observedAtMs + 300_000,
	});
}

async function neonCaller(
	account: string,
	credentialRef: string,
	resolver: NeonManagedPostgresOptions["resolveCredential"],
	transport: HttpTransport,
) {
	let credential: { readonly accountId: string; readonly token: string };
	try {
		credential = await resolver(credentialRef);
	} catch {
		return refuse("Neon management credential is unavailable");
	}
	if (
		credential.accountId !== account ||
		!/^[!-~]{8,4096}$/u.test(credential.token)
	)
		return refuse("Neon management credential belongs to a different account");
	const send = guardTransport(transport, {
		allowedHosts: ["console.neon.tech"],
		allowedPathPrefixes: ["/api/v2/projects", "/api/v2/organizations"],
		maxTimeoutMs: 15_000,
		maxResponseBytes: 4 * 1024 * 1024,
	});
	return async (method: "GET" | "POST", path: string, data?: JsonObject) => {
		try {
			const headers = {
				authorization: `Bearer ${credential.token}`,
				accept: "application/json",
				"content-type": "application/json",
			};
			const request = {
				method,
				url: `https://console.neon.tech${path}`,
				headers,
				timeoutMs: 15_000,
				maxResponseBytes: 4 * 1024 * 1024,
			};
			return await send(
				data ? { ...request, body: JSON.stringify(data) } : request,
			);
		} catch {
			return refuse("Neon management request outcome is unavailable");
		}
	};
}
type NeonCall = Awaited<ReturnType<typeof neonCaller>>;
function belongsToOrganization(value: JsonObject, account: string): boolean {
	return (
		value.owner_id === account &&
		(value.org_id === undefined || value.org_id === account)
	);
}
async function listProjects(
	call: NeonCall,
	account: string,
): Promise<JsonObject[]> {
	const rows: JsonObject[] = [],
		seen = new Set<string>();
	let cursor = "";
	for (let page = 0; page < 100; page++) {
		const query = new URLSearchParams({ org_id: account, limit: "100" });
		if (cursor) query.set("cursor", cursor);
		const response = await call("GET", `/api/v2/projects?${query}`);
		if (response.status !== 200)
			return refuse("Neon project inventory is unavailable");
		const body = parseJsonObject(response.body);
		if (
			!isJsonArray(body.projects) ||
			(body.pagination !== undefined && !isJsonObject(body.pagination)) ||
			(body.unavailable_project_ids !== undefined &&
				(!isJsonArray(body.unavailable_project_ids) ||
					body.unavailable_project_ids.length > 0)) ||
			(body.unavailable !== undefined &&
				(!isJsonArray(body.unavailable) || body.unavailable.length))
		)
			return refuse("Neon project inventory is incomplete");
		for (const row of body.projects) {
			if (
				!isJsonObject(row) ||
				!belongsToOrganization(row, account) ||
				!isJsonString(row.id) ||
				!NATIVE.test(row.id) ||
				seen.has(row.id)
			)
				return refuse("Neon project inventory is foreign or ambiguous");
			seen.add(row.id);
			rows.push(row);
		}
		const next = isJsonObject(body.pagination)
			? body.pagination.cursor
			: undefined;
		if (next === undefined || next === null || next === "") return rows;
		if (
			!isJsonString(next) ||
			next.length > 512 ||
			next === cursor ||
			seen.has(`cursor:${next}`)
		)
			return refuse("Neon project inventory cursor is invalid");
		seen.add(`cursor:${next}`);
		cursor = next;
	}
	return refuse("Neon project inventory is incomplete");
}

/** `POST /projects` is not idempotent. Once a create is claimed, a retry
 * never sends again. Only a received 201 may populate the immutable project
 * repository; an ambiguous create without that record remains held. */
export function createNeonManagedPostgresResolver(
	options: NeonManagedPostgresOptions,
): ResourceResolver {
	const scope = Object.freeze({ ...options.scope });
	if (
		!scope.tenantId ||
		!ORG.test(scope.providerAccountId) ||
		!scope.scopeId ||
		options.journal.persistence !== "durable-cas" ||
		!(options.journal.inspect instanceof Function) ||
		options.repository.persistence !== "durable-cas" ||
		!(options.repository.read instanceof Function) ||
		!(options.repository.create instanceof Function) ||
		!(options.revalidateBeforeWrite instanceof Function) ||
		!(options.authorize instanceof Function)
	)
		throw new Error(
			"Neon managed PostgreSQL requires scoped durable authority",
		);
	const database = "hobo_journal",
		role = "hobo_journal_owner";
	function checked(raw: ResolveRequest) {
		const request = parseResolveRequest(JSON.parse(JSON.stringify(raw)));
		const d = request.desired;
		if (
			request.ref.productId !== NEON_MANAGED_POSTGRES_PRODUCT_ID ||
			request.ref.slot !== "data" ||
			(request.ref.physicalId && !NATIVE.test(request.ref.physicalId)) ||
			Object.keys(d).some(
				(key) =>
					!["idempotencyKey", "organizationId", "region", "quota"].includes(
						key,
					),
			) ||
			!isJsonString(d.idempotencyKey) ||
			!d.idempotencyKey ||
			d.idempotencyKey.length > 128 ||
			d.organizationId !== scope.providerAccountId ||
			!isJsonString(d.region) ||
			!REGION.test(d.region) ||
			!isJsonObject(d.quota)
		)
			return refuse(
				"Neon desired resource differs from its approved account or placement",
			);
		parseSecretRef(request.credentialRef);
		return { request, limits: quota(d.quota), region: d.region };
	}
	async function context(
		request: ResolveRequest,
		limits: NeonManagedQuota,
		region: string,
	) {
		const operationKey = await claimableOperationKey(
			scope,
			request,
			options.deriveOperationKey,
		);
		const name = `hobo-${hash(operationKey).slice(0, 40)}`;
		const desired = {
			name,
			org_id: scope.providerAccountId,
			region_id: region,
			pg_version: 17,
			store_passwords: true,
			branch: { name: "main", database_name: database, role_name: role },
			default_endpoint_settings: {
				autoscaling_limit_min_cu: 0.25,
				autoscaling_limit_max_cu: 0.25,
				suspend_timeout_seconds: 300,
			},
			settings: { quota: wireQuota(limits) },
		};
		const desiredDigest = `sha256:${hash(JSON.stringify(desired))}`;
		const key = `neon-managed:${hash(JSON.stringify([scope.tenantId, scope.providerAccountId, scope.scopeId, request.ref.logicalId, operationKey]))}`;
		return { name, desired, desiredDigest, key, mutationId: `${key}:create` };
	}
	async function authorize(
		request: ResolveRequest,
		operation: "read" | "create",
		desiredDigest: string,
	) {
		let evidence: NeonManagedAuthorization;
		try {
			evidence = await options.authorize({
				scope,
				request,
				operation,
				desiredDigest,
			});
		} catch {
			return refuse(
				"Neon account, budget or permission evidence is unavailable",
			);
		}
		const now = checkedTime(options.clock);
		if (
			evidence.tenantId !== scope.tenantId ||
			evidence.providerAccountId !== scope.providerAccountId ||
			evidence.scopeId !== scope.scopeId ||
			evidence.logicalId !== request.ref.logicalId ||
			evidence.operation !== operation ||
			evidence.desiredDigest !== desiredDigest ||
			!evidence.budgetId ||
			!evidence.quoteRef ||
			!evidence.permissionEvidenceRef ||
			!evidence.quotaEvidenceRef ||
			!Number.isSafeInteger(evidence.observedAtMs) ||
			!Number.isSafeInteger(evidence.expiresAtMs) ||
			evidence.observedAtMs > now ||
			evidence.expiresAtMs <= now ||
			now - evidence.observedAtMs > 300_000
		)
			return refuse(
				"Neon account, budget or permission evidence is stale or foreign",
			);
		return evidence;
	}
	async function existing(key: string, request: ResolveRequest) {
		const identity = await options.repository.read(key);
		if (!identity) {
			if (request.ref.physicalId)
				return refuse("Pinned Neon project lacks its creation record");
			return undefined;
		}
		if (
			!validIdentity(identity) ||
			(request.ref.physicalId && request.ref.physicalId !== identity.projectId)
		)
			return refuse(
				"Neon project identity differs from its immutable creation record",
			);
		return Object.freeze({ ...identity });
	}
	async function revalidate(evidence: NeonManagedAuthorization) {
		await options.revalidateBeforeWrite();
		const now = checkedTime(options.clock);
		if (
			evidence.observedAtMs > now ||
			evidence.expiresAtMs <= now ||
			now - evidence.observedAtMs > 300_000
		)
			return refuse("Neon account, budget or permission evidence expired");
	}
	function custodyClaim(key: string) {
		return {
			mutationId: `neon-custody:${hash(JSON.stringify([scope.tenantId, scope.providerAccountId, scope.scopeId, key]))}`,
			requestDigest: `sha256:${hash(JSON.stringify(["neon-custody/v1", key]))}`,
		};
	}
	async function secret(
		key: string,
		value: string,
		publish: boolean,
		evidence: NeonManagedAuthorization,
	): Promise<string | undefined> {
		const claim = custodyClaim(key);
		const lookup = async () => {
			let found: { readonly ref: string; readonly value: string } | undefined;
			try {
				found = await options.custody.read(key);
			} catch {
				return refuse("Neon binding custody is unavailable");
			}
			if (!found) return undefined;
			if (found.value !== value)
				return refuse(
					"Neon binding custody differs from its immutable generation",
				);
			return parseSecretRef(found.ref).ref;
		};
		let ref = await lookup();
		const prior = await options.journal.inspect(claim);
		if (ref) {
			if (prior.status === "missing")
				return refuse("Neon binding exists without its publication claim");
			if (publish && prior.status === "uncertain") {
				await revalidate(evidence);
				await options.journal.acknowledge(
					claim.mutationId,
					claim.requestDigest,
				);
			}
			return ref;
		}
		if (!publish) return undefined;
		await revalidate(evidence);
		const started = await options.journal.claim(claim);
		if (started.status !== "claimed")
			return refuse("Neon binding publication outcome is uncertain");
		try {
			await revalidate(evidence);
			await options.custody.create(key, value);
			ref = await lookup();
			if (!ref) throw new Error("publication not observable");
			await revalidate(evidence);
			await options.journal.acknowledge(claim.mutationId, claim.requestDigest);
			return ref;
		} catch {
			await revalidate(evidence);
			await options.journal.uncertain(claim.mutationId, claim.requestDigest);
			ref = await lookup();
			if (!ref) return refuse("Neon binding publication outcome is uncertain");
			await revalidate(evidence);
			await options.journal.acknowledge(claim.mutationId, claim.requestDigest);
			return ref;
		}
	}
	async function observed(
		call: NeonCall,
		identity: NeonManagedProjectIdentity,
		name: string,
		region: string,
		limits: NeonManagedQuota,
	) {
		const projectPath = `/api/v2/projects/${encodeURIComponent(identity.projectId)}`;
		const [p, b, e, d] = await Promise.all([
			call("GET", projectPath),
			call(
				"GET",
				`${projectPath}/branches/${encodeURIComponent(identity.branchId)}`,
			),
			call(
				"GET",
				`${projectPath}/endpoints/${encodeURIComponent(identity.endpointId)}`,
			),
			call(
				"GET",
				`${projectPath}/branches/${encodeURIComponent(identity.branchId)}/databases/${database}`,
			),
		]);
		if ([p, b, e, d].some((row) => row.status !== 200))
			return refuse("Neon project readback is unavailable");
		const project = parseJsonObject(p.body).project,
			branch = parseJsonObject(b.body).branch,
			endpoint = parseJsonObject(e.body).endpoint,
			db = parseJsonObject(d.body).database;
		if (
			!isJsonObject(project) ||
			!isJsonObject(project.settings) ||
			!isJsonObject(project.settings.quota)
		)
			return refuse("Neon project quota readback is unavailable");
		const actualQuota = project.settings.quota,
			approvedQuota = wireQuota(limits);
		if (
			!isJsonObject(branch) ||
			!isJsonObject(endpoint) ||
			!isJsonObject(db) ||
			project.id !== identity.projectId ||
			!belongsToOrganization(project, scope.providerAccountId) ||
			project.name !== name ||
			project.region_id !== region ||
			project.pg_version !== 17 ||
			project.store_passwords !== true ||
			WIRE_QUOTA_FIELDS.some(
				(key) => actualQuota[key] !== approvedQuota[key],
			) ||
			branch.id !== identity.branchId ||
			branch.project_id !== identity.projectId ||
			(branch.primary !== undefined && branch.primary !== true) ||
			branch.default !== true ||
			branch.name !== "main" ||
			endpoint.id !== identity.endpointId ||
			endpoint.project_id !== identity.projectId ||
			endpoint.branch_id !== identity.branchId ||
			endpoint.type !== "read_write" ||
			endpoint.region_id !== region ||
			endpoint.autoscaling_limit_min_cu !== 0.25 ||
			endpoint.autoscaling_limit_max_cu !== 0.25 ||
			endpoint.suspend_timeout_seconds !== 300 ||
			endpoint.disabled !== false ||
			!isJsonString(endpoint.host) ||
			endpoint.host.length > 253 ||
			!endpoint.host.startsWith(`${identity.endpointId}.`) ||
			!endpoint.host.endsWith(`.${region.slice(4)}.aws.neon.tech`) ||
			endpoint.host.split(".").some((label) => label.length > 63) ||
			!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.aws\.neon\.tech$/u.test(endpoint.host) ||
			db.name !== database ||
			db.owner_name !== role
		)
			return refuse(
				"Neon project readback differs from its approved account, quota or endpoint",
			);
		return { host: endpoint.host, projectPath };
	}
	async function outcome(
		call: NeonCall,
		identity: NeonManagedProjectIdentity,
		request: ResolveRequest,
		name: string,
		region: string,
		limits: NeonManagedQuota,
		evidence: NeonManagedAuthorization,
		action: ResolveOutcome["action"],
		publish: boolean,
	): Promise<ResolveOutcome> {
		const native = await observed(call, identity, name, region, limits);
		const query = new URLSearchParams({
			branch_id: identity.branchId,
			endpoint_id: identity.endpointId,
			database_name: database,
			role_name: role,
			pooled: "false",
		});
		const response = await call(
			"GET",
			`${native.projectPath}/connection_uri?${query}`,
		);
		if (response.status !== 200)
			return refuse("Neon database credential is unavailable");
		const raw = parseJsonObject(response.body).uri;
		if (!isJsonString(raw))
			return refuse("Neon database credential is unavailable");
		let uri: URL;
		try {
			uri = new URL(raw);
		} catch {
			return refuse("Neon database credential is invalid");
		}
		const parameters = [...uri.searchParams];
		if (
			!["postgres:", "postgresql:"].includes(uri.protocol) ||
			uri.hostname !== native.host ||
			Number(uri.port || 5432) !== 5432 ||
			uri.pathname !== `/${database}` ||
			decodeURIComponent(uri.username) !== role ||
			!uri.password ||
			uri.hash ||
			parameters.some(
				([key, value]) =>
					!(
						(key === "sslmode" &&
							["require", "verify-ca", "verify-full"].includes(value)) ||
						(key === "channel_binding" && value === "require")
					),
			) ||
			new Set(parameters.map(([key]) => key)).size !== parameters.length
		)
			return refuse(
				"Neon credential differs from its verified direct endpoint",
			);
		const password = decodeURIComponent(uri.password);
		uri.search = "";
		uri.searchParams.set("sslmode", "verify-full");
		uri.searchParams.set("channel_binding", "require");
		const started = performance.now();
		await (options.probeSession ?? probeNeonManagedSession)({
			host: native.host,
			port: 5432,
			database,
			username: role,
			password,
		});
		const latencyMs = Math.ceil(performance.now() - started);
		if (!Number.isSafeInteger(latencyMs) || latencyMs < 0)
			return refuse("Neon session timing is invalid");
		const resourceRef = await claimableResourceRef(scope, request);
		const generation = hash(
			JSON.stringify([resourceRef, identity, native.host, database, role]),
		).toUpperCase();
		const credentialRef = await secret(
			`HOBO_NEON_URI_${generation}`,
			uri.toString(),
			publish,
			evidence,
		);
		const base = {
			contract: RESOLVER_CONTRACT,
			action,
			physicalId: identity.projectId,
			diagnostics: [],
		} as const;
		if (!credentialRef)
			return {
				...base,
				outputs: {
					providerAccountId: scope.providerAccountId,
					ready: false,
					operationConfirmed: false,
					lifecycleStatus: "pending",
					observedAtMs: checkedTime(options.clock),
				},
			};
		const observedAtMs = checkedTime(options.clock),
			expiresAtMs = Math.min(evidence.expiresAtMs, observedAtMs + 300_000);
		if (expiresAtMs <= observedAtMs)
			return refuse("Neon account evidence expired before observation");
		return {
			...base,
			outputs: {
				providerAccountId: scope.providerAccountId,
				region,
				managementLatencyMs: latencyMs,
				managementSessionHealthy: true,
				managementRef: credentialRef,
				runtimeRoleStatus: "unverified",
				ready: false,
				operationConfirmed: true,
				lifecycleStatus: "pending",
				observedAtMs,
				expiresAtMs,
			},
		};
	}
	return {
		providerId: "neon",
		productId: NEON_MANAGED_POSTGRES_PRODUCT_ID,
		async read(raw, transport) {
			const { request, limits, region } = checked(raw),
				ctx = await context(request, limits, region),
				evidence = await authorize(request, "read", ctx.desiredDigest),
				identity = await existing(ctx.key, request);
			if (!identity) return undefined;
			const claim = await options.journal.inspect({
				mutationId: ctx.mutationId,
				requestDigest: ctx.desiredDigest,
			});
			if (claim.status !== "acknowledged")
				return {
					contract: RESOLVER_CONTRACT,
					action: "noop",
					physicalId: identity.projectId,
					outputs: {
						providerAccountId: scope.providerAccountId,
						ready: false,
						operationConfirmed: false,
						lifecycleStatus: "pending",
						observedAtMs: checkedTime(options.clock),
					},
					diagnostics: [],
				};
			const call = await neonCaller(
				scope.providerAccountId,
				request.credentialRef,
				options.resolveCredential,
				transport,
			);
			return outcome(
				call,
				identity,
				request,
				ctx.name,
				region,
				limits,
				evidence,
				"noop",
				false,
			);
		},
		async reconcile(raw, transport) {
			const { request, limits, region } = checked(raw),
				ctx = await context(request, limits, region),
				evidence = await authorize(request, "create", ctx.desiredDigest),
				call = await neonCaller(
					scope.providerAccountId,
					request.credentialRef,
					options.resolveCredential,
					transport,
				);
			let identity = await existing(ctx.key, request);
			const prior = await options.journal.inspect({
				mutationId: ctx.mutationId,
				requestDigest: ctx.desiredDigest,
			});
			if (identity && prior.status === "missing")
				return refuse("Neon project exists without its creation claim");
			if (!identity) {
				if (prior.status !== "missing")
					return refuse(
						"Neon creation outcome is uncertain; its exact native identity is not recorded",
					);
				const projects = await listProjects(call, scope.providerAccountId);
				if (projects.some((row) => row.name === ctx.name))
					return refuse("Neon project name is already occupied");
				if (evidence.expiresAtMs - checkedTime(options.clock) < 15_000)
					return refuse("Neon approval expires before creation can finish");
				await revalidate(evidence);
				const started = await options.journal.claim({
					mutationId: ctx.mutationId,
					requestDigest: ctx.desiredDigest,
				});
				if (started.status !== "claimed")
					return refuse("Neon creation outcome is uncertain");
				try {
					await revalidate(evidence);
					const response = await call("POST", "/api/v2/projects", {
						project: ctx.desired,
					});
					const body = parseJsonObject(response.body),
						project = body.project,
						branch = body.branch,
						endpoints = body.endpoints;
					if (
						response.status !== 201 ||
						!isJsonObject(project) ||
						!isJsonObject(branch) ||
						!isJsonArray(endpoints) ||
						!belongsToOrganization(project, scope.providerAccountId) ||
						project.name !== ctx.name ||
						project.region_id !== region ||
						!isJsonString(project.id) ||
						!isJsonString(branch.id) ||
						branch.project_id !== project.id ||
						branch.name !== "main" ||
						branch.default !== true
					)
						throw new Error("unconfirmed creation");
					const matching = endpoints.filter(
						(endpoint) =>
							isJsonObject(endpoint) &&
							endpoint.project_id === project.id &&
							endpoint.branch_id === branch.id &&
							endpoint.type === "read_write" &&
							isJsonString(endpoint.id),
					);
					const endpoint = matching[0];
					if (
						matching.length !== 1 ||
						!isJsonObject(endpoint) ||
						!isJsonString(endpoint.id)
					)
						throw new Error("unconfirmed endpoint");
					identity = {
						projectId: project.id,
						branchId: branch.id,
						endpointId: endpoint.id,
					};
					if (!validIdentity(identity)) throw new Error("unconfirmed identity");
					await revalidate(evidence);
					await options.repository.create(ctx.key, identity);
					const saved = await options.repository.read(ctx.key);
					if (
						!saved ||
						saved.projectId !== identity.projectId ||
						saved.branchId !== identity.branchId ||
						saved.endpointId !== identity.endpointId
					)
						throw new Error("creation identity not recorded");
					await revalidate(evidence);
					await options.journal.acknowledge(ctx.mutationId, ctx.desiredDigest);
				} catch {
					await revalidate(evidence);
					await options.journal.uncertain(ctx.mutationId, ctx.desiredDigest);
					return refuse("Neon project creation outcome is uncertain");
				}
				return outcome(
					call,
					identity,
					request,
					ctx.name,
					region,
					limits,
					evidence,
					"create",
					true,
				);
			}
			if (prior.status === "uncertain") {
				await observed(call, identity, ctx.name, region, limits);
				await revalidate(evidence);
				await options.journal.acknowledge(ctx.mutationId, ctx.desiredDigest);
			}
			return outcome(
				call,
				identity,
				request,
				ctx.name,
				region,
				limits,
				evidence,
				"noop",
				true,
			);
		},
		async delete() {
			return refuse(
				"Neon journal data is retained by the hosting retirement policy",
			);
		},
	};
}
