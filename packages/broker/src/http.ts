import { createServer, type Server } from "node:http";
import type { HoboBroker } from "./broker.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { BrokerParseError } from "./policies.js";
import { REJECTION_MATRIX } from "./rejections.js";
import {
	BROKER_SCHEMA_VERSION,
	type PolicyHash,
	type ResolutionReceipt,
} from "./types.js";

// The hosted authority surface: the same resolve/scale/deliver pipeline
// exposed over HTTP so the broker can run as the hosted Meta-cloud Broker
// (the M4 direction) and be fronted by the Gateway, the CLI, or MCP. The
// handler is a pure request→response function — `serveBroker` binds it to
// node:http — and the resolve route is PROVIDER-verified against
// contracts/pacts/broker_resolution.pact.json (contracts/provider/), so the
// hosted surface and the consumer contract can never drift apart.

export interface BrokerHttpRequest {
	method: string;
	path: string;
	body?: unknown;
}

export interface BrokerHttpResponse {
	status: number;
	body: JsonObject;
}

function jsonBody<T>(value: T): JsonObject {
	const body = cloneAsJson(value);
	return isJsonObject(body) ? body : { value: body };
}

function brandedPolicyHash(value: string): PolicyHash {
	// SAFETY: receipt parse already proved a non-empty policy hash string.
	return value as PolicyHash;
}

function parseHttpResolutionReceipt(value: JsonObject): ResolutionReceipt {
	if (
		!isJsonString(value.requestId) ||
		!isJsonString(value.brokerId) ||
		!isJsonString(value.catalogHash) ||
		!isJsonString(value.policyHash) ||
		!isJsonString(value.placementPolicyId) ||
		!isJsonString(value.stationId) ||
		!isJsonString(value.railHash)
	) {
		throw new BrokerParseError(
			"invalid-receipt",
			"deliver requires a complete resolution receipt",
		);
	}
	return {
		schemaVersion: BROKER_SCHEMA_VERSION,
		requestId: value.requestId,
		brokerId: value.brokerId,
		catalogHash: value.catalogHash,
		policyHash: brandedPolicyHash(value.policyHash),
		placementPolicyId: value.placementPolicyId,
		placements: [],
		stationId: value.stationId,
		railHash: value.railHash,
	};
}

// Status mapping mirrors the resolution pact: 200 resolved, 402 when the
// leading rejection reason is billing-plane, 403 for every other rejection.
function rejectionStatus(plane: string | undefined): number {
	return plane === "billing" ? 402 : 403;
}

export function createBrokerHttpHandler(
	broker: HoboBroker,
): (request: BrokerHttpRequest) => Promise<BrokerHttpResponse> {
	return async (request) => {
		try {
			if (request.method === "POST" && request.path === "/broker/resolve") {
				const resolution = await broker.resolve(cloneAsJson(request.body));
				if (resolution.outcome === "resolved") {
					return {
						status: 200,
						body: jsonBody({
							outcome: resolution.outcome,
							receipt: resolution.receipt,
							...(resolution.signature !== undefined
								? { signature: { ...resolution.signature } }
								: undefined),
							events: resolution.events,
						}),
					};
				}
				return {
					status: rejectionStatus(resolution.rejection?.reasons[0]?.plane),
					body: jsonBody({
						outcome: resolution.outcome,
						rejection: resolution.rejection,
						...(resolution.signature !== undefined
							? { signature: { ...resolution.signature } }
							: undefined),
						events: resolution.events,
					}),
				};
			}
			if (request.method === "POST" && request.path === "/broker/scale") {
				const { directive, events } = broker.scale(cloneAsJson(request.body));
				return {
					status: 200,
					body: jsonBody({ directive: { ...directive }, events }),
				};
			}
			if (request.method === "POST" && request.path === "/broker/deliver") {
				const payload = cloneAsJson(request.body);
				if (!isJsonObject(payload) || !isJsonString(payload.requestId)) {
					throw new BrokerParseError(
						"invalid-receipt",
						"deliver requires a resolution receipt object",
					);
				}
				const receipt = parseHttpResolutionReceipt(payload);
				const { ticket, events } = await broker.deliver(receipt);
				return {
					status: 200,
					body: jsonBody({ ticket: { ...ticket }, events }),
				};
			}
			if (
				request.method === "GET" &&
				request.path === "/broker/rejection-matrix"
			) {
				return {
					status: 200,
					body: { matrix: REJECTION_MATRIX.map((row) => ({ ...row })) },
				};
			}
			return {
				status: 404,
				body: {
					error: "not-found",
					message: `${request.method} ${request.path}`,
				},
			};
		} catch (error) {
			if (error instanceof BrokerParseError) {
				return {
					status: 400,
					body: { error: error.code, message: error.message },
				};
			}
			const code =
				error instanceof Error && "code" in error && isJsonString(error.code)
					? error.code
					: "broker-internal";
			return {
				status: 502,
				body: { error: code, message: String(error) },
			};
		}
	};
}

// Bind the handler to a real node:http server for hosted operation. Returns
// the server so the host controls lifecycle (and tests can close it).
export function serveBroker(
	broker: HoboBroker,
	options: { port?: number } = {},
): Server {
	const handle = createBrokerHttpHandler(broker);
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body: JsonValue;
			try {
				body = raw.length > 0 ? JSON.parse(raw) : undefined;
			} catch {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "invalid-json" }));
				return;
			}
			void handle({
				method: req.method ?? "GET",
				path: req.url ?? "/",
				body,
			}).then((response) => {
				res.writeHead(response.status, {
					"content-type": "application/json",
				});
				res.end(JSON.stringify(response.body));
			});
		});
	});
	server.listen(options.port ?? 0);
	return server;
}
