/**
 * Test doubles for the box worker's fleet daemon (design §11.3 rules 6 and 9:
 * doubles against frozen interfaces, no module mocking). `createTestAuthority`
 * is the real authority composition; this file adds only what a device needs
 * to reach it in-process: the three routes the agent calls (discovery,
 * enrollment, credentials), answered as protobuf JSON with a `Date` header,
 * and a `FleetBusConnector` whose connections are views of the memory bus.
 */
import {
	create,
	fromJsonString,
	type Message,
	toJsonString,
} from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import { type PrincipalRef, parseTenantId, type TenantId } from "@hobo/core";
import {
	ApprovalMode,
	type AuthorityBus,
	type Clock,
	CoordinationMode,
	CredentialRequestSchema,
	CredentialResponseSchema,
	DeviceClass,
	DiscoverySchema,
	type EnrollmentAuthority,
	EnrollmentRequestSchema,
	EnrollmentResponseSchema,
	FLEET_ERROR_HTTP_STATUS,
	type FleetBus,
	type FleetBusConnector,
	FleetErrorSchema,
	type FleetFailure,
	FleetRecordSchema,
	type Outcome,
	type Role,
	TokenCreateRequestSchema,
	type VerifiedToken,
} from "@hobo/fleet";
import { createTestAuthority } from "@hobo/fleet/testing";

export const AUTHORITY_ORIGIN = "https://authority.fleet.test";
export const TENANT: TenantId = parseTenantId("test");
export const FLEET = "hobo";
const ADMIN: PrincipalRef = { kind: "user", id: "admin" };

type Answer = Readonly<{ status: number; body: string }>;

function failure(error: FleetFailure): Answer {
	return {
		status: FLEET_ERROR_HTTP_STATUS[error.code] ?? 400,
		body: toJsonString(
			FleetErrorSchema,
			create(FleetErrorSchema, { code: error.code, message: error.message }),
		),
	};
}

function answer<T extends Message>(
	schema: GenMessage<T>,
	outcome: Outcome<T>,
): Answer {
	return outcome.ok
		? { status: 200, body: toJsonString(schema, outcome.value) }
		: failure(outcome.error);
}

/** The authority's HTTP surface for a device, in-process: discovery, enrollment and credentials. */
function deviceRoutes(authority: EnrollmentAuthority, now: Clock) {
	const route = async (
		method: string,
		url: URL,
		headers: Headers,
		text: string,
	): Promise<Answer> => {
		let caller: VerifiedToken | undefined;
		const authorization = headers.get("authorization") ?? "";
		const dpop = headers.get("dpop") ?? "";
		if (authorization.length > 0 || dpop.length > 0) {
			const verified = await authority.authenticate({
				method,
				url: `${url.origin}${url.pathname}`,
				authorization,
				dpop,
			});
			if (verified.ok) caller = verified.value;
		}
		const body = text.length === 0 ? "{}" : text;
		const discovery = /^\/v1\/fleet\/tenants\/([^/]+)\/discovery$/u.exec(
			url.pathname,
		);
		if (method === "GET" && discovery !== null)
			return answer(
				DiscoverySchema,
				await authority.discovery(
					{ tenant: parseTenantId(decodeURIComponent(discovery[1] ?? "")) },
					caller,
				),
			);
		if (method === "POST" && url.pathname === "/v1/fleet/members")
			return answer(
				EnrollmentResponseSchema,
				await authority.enroll(
					fromJsonString(EnrollmentRequestSchema, body),
					caller,
				),
			);
		const credentials = /^\/v1\/fleet\/members\/([^/]+)\/credentials$/u.exec(
			url.pathname,
		);
		if (method === "POST" && credentials !== null) {
			if (caller === undefined)
				return failure({ code: "unauthenticated", message: "no credential" });
			return answer(
				CredentialResponseSchema,
				await authority.credentials(
					{
						memberId: decodeURIComponent(credentials[1] ?? ""),
						request: fromJsonString(CredentialRequestSchema, body),
					},
					caller,
				),
			);
		}
		return failure({ code: "invalid-request", message: "no such route" });
	};
	const fetchDouble: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== AUTHORITY_ORIGIN)
			throw new TypeError(`unexpected origin ${url.origin}`);
		const decided = await route(
			init?.method ?? "GET",
			url,
			new Headers(init?.headers),
			init?.body === undefined || init.body === null ? "" : String(init.body),
		);
		return new Response(decided.body, {
			status: decided.status,
			headers: {
				"content-type": "application/json",
				date: new Date(now()).toUTCString(),
			},
		});
	};
	return fetchDouble;
}

/** Each connection is the memory bus itself; closing one stops nothing shared. */
function memoryConnector(bus: AuthorityBus): FleetBusConnector {
	return {
		async connect(input) {
			await input.ticket();
			let closed = false;
			const connection: FleetBus = {
				registry: bus.registry,
				observations: bus.observations,
				claims: bus.claims,
				offers: bus.offers,
				submissions: bus.submissions,
				orders: bus.orders,
				events: bus.events,
				control: bus.control,
				relay: bus.relay,
				status: () => (closed ? "closed" : "connected"),
				async close() {
					closed = true;
				},
			};
			return connection;
		},
	};
}

/** `createTestAuthority`, fleet `hobo` (many-active, owner auto-approves) and a bootstrap token for given roles. */
export async function boxWorld(
	now: Clock,
	options: Readonly<{ allowHostDocker: boolean }> = { allowHostDocker: false },
) {
	const composed = await createTestAuthority(now);
	await composed.signInAs(ADMIN, ["fleet-admin"]);
	const admin: VerifiedToken = {
		kind: "person",
		principal: ADMIN,
		tenant: TENANT,
		tags: ["fleet-admin"],
		jkt: "admin-key",
		expiresAtMs: now() + 24 * 3_600_000,
	};
	const defined = await composed.authority.defineFleet(
		create(FleetRecordSchema, {
			fleetId: FLEET,
			tenant: TENANT,
			owner: "user:admin",
			coordination: CoordinationMode.MANY_ACTIVE,
			policy: {
				approval: ApprovalMode.AUTO_OWNER,
				allowHostDocker: options.allowHostDocker,
				// The authority accepts host Docker only for a DEDICATED-only fleet.
				allowedClasses: options.allowHostDocker ? [DeviceClass.DEDICATED] : [],
			},
		}),
		admin,
	);
	if (!defined.ok) throw new Error(`defineFleet: ${defined.error.message}`);
	const token = async (name: string, roles: readonly Role[]) => {
		const issued = await composed.authority.issueToken(
			create(TokenCreateRequestSchema, {
				fleet: FLEET,
				name,
				displayName: name,
				deviceClass: DeviceClass.DEDICATED,
				roles: [...roles],
				ttlSeconds: 900,
			}),
			admin,
		);
		if (!issued.ok) throw new Error(`issueToken: ${issued.error.message}`);
		return issued.value.token;
	};
	return {
		...composed,
		fetch: deviceRoutes(composed.authority, now),
		connector: memoryConnector(composed.bus),
		token,
	};
}
