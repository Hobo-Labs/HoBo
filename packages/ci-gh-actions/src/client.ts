import {
	create,
	type DescMessage,
	fromJsonString,
	toJsonString,
} from "@bufbuild/protobuf";
import {
	AccountSchema,
	AccountStateSchema,
	BudgetSignalSchema,
	ConnectionSchema,
	DesiredCiPolicySchema,
	LeaseSchema,
	OfferSchema,
	parseCiPolicy,
	ReconcileRequestSchema,
	RepositorySetupRequestSchema,
	SnapshotSchema,
} from "@hobo/ci";
import { MeshNodeReportsSchema } from "./_generated/mesh_pb.js";
import {
	OnboardingOperationSchema,
	OnboardingPrincipalSchema,
} from "./_generated/onboarding_pb.js";

export {
	type MeshNodeReport,
	type MeshNodeReports,
	MeshNodeReportsSchema,
} from "./_generated/mesh_pb.js";
export { parseMeshNodeReports } from "./mesh-records.js";

type ProtobufInput<Desc extends DescMessage> = NonNullable<
	Parameters<typeof create<Desc>>[1]
>;
type ProtobufMessage<Desc extends DescMessage> = ReturnType<
	typeof create<Desc>
>;

/** Status is zero for local validation, credentials or transport failures.
 * Error messages never contain response bodies, tokens or request values. */
export class CiRelayClientError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "CiRelayClientError";
	}
}
function invalid(message: string): never {
	throw new CiRelayClientError(0, message);
}
function uuid(id: string): void {
	if (
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
	)
		invalid("invalid operation or lease identifier");
}
function revision(value: number): string {
	if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
		invalid("invalid configuration revision");
	return `"${value}"`;
}
function origin(value: string, allowInsecureLoopback: boolean): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return invalid("invalid relay origin");
	}
	const loopback =
		allowInsecureLoopback &&
		url.protocol === "http:" &&
		["127.0.0.1", "localhost"].includes(url.hostname);
	if (
		(!loopback && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		invalid(
			"relay requires an HTTPS origin or explicit insecure loopback development mode",
		);
	return url.origin;
}
function encode<Desc extends DescMessage>(
	schema: Desc,
	input: ProtobufInput<Desc>,
): string {
	try {
		return toJsonString(schema, create(schema, input));
	} catch {
		return invalid("invalid protobuf request");
	}
}

async function responseText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 2 * 1024 * 1024) {
				// Disposal is best effort; a stalled source must not stall refusal.
				void reader.cancel().catch(() => undefined);
				throw new Error("Relay response is too large");
			}
			chunks.push(chunk.value);
		}
		const combined = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			combined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(combined);
	} finally {
		reader.releaseLock();
	}
}

/** Account tokens are obtained per operation; tenant routing always uses /self. */
export function createCiRelayClient(
	options: {
		origin: string;
		fetch?: typeof fetch;
		allowInsecureLoopback?: boolean;
	} & (
		| { accountToken: () => string | Promise<string>; ownerSession?: never }
		| { ownerSession: true; accountToken?: never }
	),
) {
	const base = origin(options.origin, options.allowInsecureLoopback ?? false);
	const send = options.fetch ?? fetch;
	async function request<Desc extends DescMessage>(
		path: string,
		method: "GET" | "PUT" | "POST",
		schema: Desc,
		body?: string,
		match?: string,
		version: "v1" | "v2" = "v1",
		// The account's own routes, or the relay's (its mesh), which no
		// account owns.
		root: "accounts/self" | "mesh" = "accounts/self",
		/** Read past fields a newer relay adds, for an answer that is a report, not an instruction. */
		lenient = false,
	): Promise<ProtobufMessage<Desc>> {
		const headers = new Headers();
		if (options.ownerSession) {
			headers.set("X-HoBo-Owner-Control", "1");
		} else {
			let token: string;
			try {
				token = await options.accountToken();
			} catch {
				return invalid("account credentials unavailable");
			}
			if (!token || /\s/.test(token) || token.length > 1024)
				invalid("invalid account credentials");
			headers.set("Authorization", `Bearer ${token}`);
		}
		if (method !== "GET") headers.set("Content-Type", "application/json");
		if (match !== undefined) headers.set("If-Match", match);
		const init: RequestInit = {
			method,
			headers,
			redirect: "error",
			signal: AbortSignal.timeout(30000),
			credentials: "same-origin",
		};
		if (body !== undefined) init.body = body;
		let response: Response;
		try {
			response = await send(`${base}/${version}/${root}/${path}`, init);
		} catch {
			throw new CiRelayClientError(
				0,
				"relay transport failed; operation outcome may be unconfirmed",
			);
		}
		function refuseResponse(message: string): never {
			// Disposal must neither delay nor replace the sanitized refusal.
			void Promise.resolve()
				.then(() => response.body?.cancel())
				.catch(() => undefined);
			throw new CiRelayClientError(response.status, message);
		}
		let responseOrigin = base;
		try {
			if (response.url) responseOrigin = new URL(response.url).origin;
		} catch {
			return refuseResponse("invalid relay response origin");
		}
		if (response.redirected || responseOrigin !== base)
			return refuseResponse("relay response crossed origin or redirected");
		if (!response.ok)
			return refuseResponse(`relay request failed (${response.status})`);
		try {
			return fromJsonString(schema, await responseText(response), {
				ignoreUnknownFields: lenient,
			});
		} catch {
			throw new CiRelayClientError(
				response.status,
				"invalid protobuf relay response",
			);
		}
	}
	return {
		getPolicy() {
			return request("policy", "GET", AccountStateSchema);
		},
		putPolicy(
			account: ProtobufInput<typeof AccountSchema>,
			version: { revision: number },
		) {
			const match = revision(version.revision);
			const body = encode(AccountSchema, account);
			return request("policy", "PUT", AccountStateSchema, body, match);
		},
		putDesiredPolicy(
			policy: ProtobufInput<typeof DesiredCiPolicySchema>,
			version: { revision: number },
		) {
			let body: string;
			try {
				body = toJsonString(
					DesiredCiPolicySchema,
					parseCiPolicy(JSON.stringify(policy)),
				);
			} catch {
				return invalid("invalid desired CI policy");
			}
			return request(
				"policy",
				"PUT",
				AccountStateSchema,
				body,
				revision(version.revision),
				"v2",
			);
		},
		putProvider(
			offer: ProtobufInput<typeof OfferSchema>,
			version: { revision: number },
		) {
			return request(
				"providers",
				"PUT",
				AccountStateSchema,
				encode(OfferSchema, offer),
				revision(version.revision),
				"v2",
			);
		},
		/** A trusted publisher re-attests a zero-credit rate, not an allocation. */
		reattestRate(
			input: {
				offerId: string;
				checkedAt: string;
				validUntil: string;
				sourceUrl: string;
			},
			version: { revision: number },
		) {
			return request(
				"rate-observations",
				"POST",
				AccountStateSchema,
				JSON.stringify(input),
				revision(version.revision),
				"v2",
			);
		},
		getSignalState() {
			return request(
				"signals",
				"GET",
				AccountStateSchema,
				undefined,
				undefined,
				"v2",
			);
		},
		publishBudgetSignal(
			signal: ProtobufInput<typeof BudgetSignalSchema>,
			version: { revision: number },
		) {
			return request(
				"signals",
				"POST",
				AccountStateSchema,
				encode(BudgetSignalSchema, signal),
				revision(version.revision),
				"v2",
			);
		},
		getInstallations() {
			return request("installations", "GET", OnboardingPrincipalSchema);
		},
		connectIsolatedRepository(
			input: ProtobufInput<typeof RepositorySetupRequestSchema>,
			version: { revision: number },
		) {
			return request(
				"repositories/isolated-connect",
				"POST",
				ConnectionSchema,
				encode(RepositorySetupRequestSchema, input),
				revision(version.revision),
			);
		},
		prepareRepository(
			input: ProtobufInput<typeof RepositorySetupRequestSchema>,
		) {
			return request(
				"repositories/prepare",
				"POST",
				OnboardingOperationSchema,
				encode(RepositorySetupRequestSchema, input),
			);
		},
		getSetup(id: string) {
			uuid(id);
			return request(`repositories/${id}`, "GET", OnboardingOperationSchema);
		},
		applySetup(id: string) {
			uuid(id);
			return request(
				`repositories/${id}/apply`,
				"POST",
				OnboardingOperationSchema,
			);
		},
		connectSetup(id: string, version: { revision: number }) {
			uuid(id);
			const match = revision(version.revision);
			return request(
				`repositories/${id}/connect`,
				"POST",
				OnboardingOperationSchema,
				undefined,
				match,
			);
		},
		getLeases() {
			return request("leases", "GET", SnapshotSchema);
		},
		/**
		 * The relay mesh's nodes as the relay sees them: availability,
		 * capacity and trust, with a capacity summary. A relay with no mesh
		 * answers `mesh: "not-configured"`. Needs the `policy:read` scope.
		 */
		getMeshNodes() {
			return request(
				"nodes",
				"GET",
				MeshNodeReportsSchema,
				undefined,
				undefined,
				"v1",
				"mesh",
				// A newer relay may add fields; the nodes are still shown.
				true,
			);
		},
		getLease(id: string) {
			uuid(id);
			return request(`leases/${id}`, "GET", LeaseSchema);
		},
		reconcileLease(id: string, hostRunId: number) {
			uuid(id);
			if (!Number.isSafeInteger(hostRunId) || hostRunId < 1)
				invalid("invalid host run identifier");
			return request(
				`leases/${id}/reconcile`,
				"POST",
				LeaseSchema,
				encode(ReconcileRequestSchema, { hostRunId }),
			);
		},
	};
}
