// A minimal Kubernetes API client over HttpTransport: no client library, no
// kubeconfig, no ambient credentials. The bearer token is resolved per call
// from the CredentialResolver (bearer, or the host-side exec plugin's
// ExecCredential status), placed in the Authorization header and nowhere else.
import type { CredentialResolver } from "@hobo/cd";
import type {
	HttpTransport,
	JsonObject,
	JsonValue,
	TransportMethod,
	TransportResponse,
} from "@hobo/core";
import { KubeAuth } from "../_generated/kube_fleet_pb.js";
import { KUBE_FLEET_DEFAULTS, type KubeHub } from "../config.js";
import { KubeFleetError } from "../errors.js";
import { isJsonObject, parseJsonText, stringAt } from "../json.js";
import { KUBE_FLEET_METRICS, type Meter } from "../telemetry.js";

export type WatchEventType =
	| "ADDED"
	| "MODIFIED"
	| "DELETED"
	| "BOOKMARK"
	| "ERROR";

export type WatchEvent = Readonly<{ type: WatchEventType; object: JsonObject }>;

export type Query = Readonly<Record<string, string>>;

export interface KubeApi {
	readonly hub: KubeHub;
	/** GET one object; undefined on 404. */
	get(path: string): Promise<JsonObject | undefined>;
	/** GET a list. */
	list(path: string, query?: Query): Promise<JsonObject>;
	create(path: string, body: JsonObject): Promise<JsonObject>;
	/** PUT with the body's metadata.resourceVersion (optimistic concurrency). */
	replace(path: string, body: JsonObject): Promise<JsonObject>;
	/** DELETE; false on 404. */
	remove(
		path: string,
		propagationPolicy?: "Foreground" | "Background" | "Orphan",
	): Promise<boolean>;
	/**
	 * One bounded watch request (timeoutSeconds): the server closes the stream
	 * and the newline-delimited events are returned. A 410 Gone (or an ERROR
	 * event with code 410) throws `kube-conflict` with status 410: re-list.
	 */
	watch(path: string, query: Query): Promise<readonly WatchEvent[]>;
}

export type KubeApiDeps = Readonly<{
	hub: KubeHub;
	http: HttpTransport;
	credentials: CredentialResolver;
	now: () => number;
	meter?: Meter;
}>;

const WATCH_TYPES = new Set<string>([
	"ADDED",
	"MODIFIED",
	"DELETED",
	"BOOKMARK",
	"ERROR",
]);

function isWatchType(value: string): value is WatchEventType {
	return WATCH_TYPES.has(value);
}

/** Credential scope string the host's resolver receives. */
export function credentialScope(hub: KubeHub): string {
	return hub.auth === KubeAuth.EXEC
		? `kube-exec:${hub.name}`
		: `kube-api:${hub.name}`;
}

/**
 * Turn a resolved credential into a bearer token. Exec plugins return an
 * ExecCredential status: `token`, optional `expirationTimestamp`, or client
 * certificate data (unsupported over HttpTransport).
 */
export function bearerFrom(
	resolved: Readonly<Record<string, string>>,
	ref: string,
	nowMs: number,
): string {
	const token = resolved.token;
	if (token === undefined || token === "") {
		if (
			resolved.clientCertificateData !== undefined ||
			resolved.clientKeyData !== undefined
		)
			throw new KubeFleetError(
				"kube-credential-unsupported",
				`credential ${ref} returned client-certificate data, not a token`,
			);
		throw new KubeFleetError(
			"kube-credential-missing",
			`credential ${ref} has no token`,
		);
	}
	const expires = resolved.expirationTimestamp;
	if (expires !== undefined && expires !== "") {
		const at = Date.parse(expires);
		if (Number.isNaN(at) || at <= nowMs)
			throw new KubeFleetError(
				"kube-credential-expired",
				`credential ${ref} expired at ${expires}`,
			);
	}
	return token;
}

function failure(response: TransportResponse, what: string): KubeFleetError {
	const { status } = response;
	if (status === 401 || status === 403)
		return new KubeFleetError(
			"kube-auth-failed",
			`${what}: HTTP ${status}`,
			status,
		);
	if (status === 409 || status === 410)
		return new KubeFleetError(
			"kube-conflict",
			`${what}: HTTP ${status}`,
			status,
		);
	if (status === 429 || status >= 500)
		return new KubeFleetError(
			"kube-unavailable",
			`${what}: HTTP ${status}`,
			status,
		);
	const message = stringAt(parseJsonText(response.body), "message");
	return new KubeFleetError(
		"kube-response-invalid",
		`${what}: HTTP ${status}${message !== undefined ? ` (${message.slice(0, 200)})` : ""}`,
		status,
	);
}

function objectBody(response: TransportResponse, what: string): JsonObject {
	const value = parseJsonText(response.body);
	if (!isJsonObject(value))
		throw new KubeFleetError(
			"kube-response-invalid",
			`${what}: body is not a JSON object`,
		);
	return value;
}

function verbOf(method: TransportMethod, query: Query | undefined): string {
	if (method === "GET") return query?.watch === "1" ? "watch" : "get";
	if (method === "POST") return "create";
	if (method === "PUT") return "update";
	if (method === "DELETE") return "delete";
	return method.toLowerCase();
}

export function createKubeApi(deps: KubeApiDeps): KubeApi {
	const { hub, http, credentials, now, meter } = deps;

	async function call(
		method: TransportMethod,
		path: string,
		query?: Query,
		body?: JsonValue,
		timeoutMs = hub.timeoutMs,
	): Promise<TransportResponse> {
		const resolved = await credentials.resolve(
			hub.credentialRef,
			credentialScope(hub),
		);
		const token = bearerFrom(resolved, hub.credentialRef, now());
		const search =
			query === undefined || Object.keys(query).length === 0
				? ""
				: `?${new URLSearchParams(Object.entries(query).sort(([a], [b]) => a.localeCompare(b))).toString()}`;
		const verb = verbOf(method, query);
		let response: TransportResponse;
		try {
			response = await http({
				method,
				url: `${hub.apiBaseUrl}${path}${search}`,
				headers: {
					accept: "application/json",
					authorization: `Bearer ${token}`,
					...(body !== undefined
						? { "content-type": "application/json" }
						: undefined),
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : undefined),
				timeoutMs,
				maxResponseBytes: KUBE_FLEET_DEFAULTS.maxResponseBytes,
			});
		} catch (error) {
			meter?.count(KUBE_FLEET_METRICS.apiCalls, {
				hub: hub.name,
				verb,
				code: "transport",
			});
			throw new KubeFleetError(
				"kube-unavailable",
				`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		meter?.count(KUBE_FLEET_METRICS.apiCalls, {
			hub: hub.name,
			verb,
			code: String(response.status),
		});
		return response;
	}

	const ok = (r: TransportResponse): boolean =>
		r.status >= 200 && r.status < 300;

	const api: KubeApi = {
		hub,
		async get(path) {
			const response = await call("GET", path);
			if (response.status === 404) return undefined;
			if (!ok(response)) throw failure(response, `GET ${path}`);
			return objectBody(response, `GET ${path}`);
		},
		async list(path, query) {
			const response = await call("GET", path, query);
			if (!ok(response)) throw failure(response, `LIST ${path}`);
			return objectBody(response, `LIST ${path}`);
		},
		async create(path, body) {
			const response = await call("POST", path, undefined, body);
			if (!ok(response)) throw failure(response, `POST ${path}`);
			return objectBody(response, `POST ${path}`);
		},
		async replace(path, body) {
			const response = await call("PUT", path, undefined, body);
			if (!ok(response)) throw failure(response, `PUT ${path}`);
			return objectBody(response, `PUT ${path}`);
		},
		async remove(path, propagationPolicy) {
			const response = await call(
				"DELETE",
				path,
				undefined,
				propagationPolicy === undefined
					? undefined
					: { apiVersion: "v1", kind: "DeleteOptions", propagationPolicy },
			);
			if (response.status === 404) return false;
			if (!ok(response)) throw failure(response, `DELETE ${path}`);
			return true;
		},
		async watch(path, query) {
			const seconds = Number(query.timeoutSeconds ?? "0");
			const response = await call(
				"GET",
				path,
				{ ...query, watch: "1" },
				undefined,
				Math.max(hub.timeoutMs, (seconds + 10) * 1000),
			);
			if (!ok(response)) throw failure(response, `WATCH ${path}`);
			const events: WatchEvent[] = [];
			for (const line of response.body.split("\n")) {
				if (line.trim() === "") continue;
				const value = parseJsonText(line);
				const type = stringAt(value, "type");
				const object = isJsonObject(value) ? value.object : undefined;
				if (type === undefined || !isWatchType(type) || !isJsonObject(object))
					throw new KubeFleetError(
						"kube-response-invalid",
						`WATCH ${path}: malformed event`,
					);
				if (type === "ERROR") {
					const code = object.code;
					if (code === 410)
						throw new KubeFleetError(
							"kube-conflict",
							`WATCH ${path}: resourceVersion expired`,
							410,
						);
					throw new KubeFleetError(
						"kube-unavailable",
						`WATCH ${path}: ${stringAt(object, "message") ?? "error event"}`,
					);
				}
				events.push(Object.freeze({ type, object }));
			}
			return Object.freeze(events);
		},
	};
	return Object.freeze(api);
}
