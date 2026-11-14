/**
 * O43: the relay's fleet surfaces are read-only calls through the client.
 *
 * `GET /v1/fleet/members`, the `list_fleet_members`, `get_fleet_view` and
 * `get_fleet_verdict` tools and the `hobo-ci://fleet/members` resource answer
 * from a recording fake `FleetClient`; none of them calls a method that
 * writes; the mesh's names are gone. (The file keeps its name: O43 runs it by
 * that name.)
 */
import { create, fromJsonString, toBinary } from "@bufbuild/protobuf";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import {
	Availability,
	FLEET_VIEW_CONTEXT,
	type FleetClient,
	type FleetFailure,
	FleetVerdictSchema,
	FleetViewSchema,
	MEMBER_RECORD_CONTEXT,
	MemberKind,
	MemberListSchema,
	MemberRecordSchema,
	MemberState,
	type Outcome,
	parseFleetId,
	Role,
	SignedEnvelopeSchema,
	VerdictState,
} from "@hobo/fleet";
import { createFleetClient } from "@hobo/fleet/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { relayInstallAssets } from "../src/assets.js";
import { createCiRelayClient } from "../src/client.js";
import {
	createHostedControlPlane,
	RELAY_FLEET_MEMBERS_PATH,
	type RelayFleet,
	relayFleetReads,
} from "../src/hosted-control.js";
import { HostedRelay } from "../src/hosted-relay.js";
import { createRelayHandler } from "../src/http-handler.js";
import { createRelayMcp, type RelayMcpOptions } from "../src/relay-mcp.js";
import { config, NOW, SECRET } from "./fixtures.js";

const ORIGIN = "https://relay.example";
const READER = "Bearer reader-credential-of-at-least-32-characters";
const OPERATOR = "Bearer operator-credential-of-at-least-32-characters";
const WRITER = "Bearer writer-credential-of-at-least-32-characters";
const SCOPES = new Map([
	[READER, ["policy:read"]],
	[OPERATOR, ["operations:write"]],
	[WRITER, ["policy:write"]],
]);
const HOBO = parseFleetId("hobo");
const BOX_A = `dev_${"a".repeat(32)}`;
const BOX_B = `dev_${"b".repeat(32)}`;
/** The authority's methods that only read; every other method of the client writes. */
const READS = ["listMembers", "fleetView", "fleetVerdict"];

const Structured = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
	structuredContent: z.record(z.string(), z.unknown()).optional(),
});
const Contents = z.object({
	contents: z.array(z.object({ uri: z.string(), text: z.string() })),
});
const Members = z.object({
	configured: z.boolean(),
	fleet: z.string(),
	members: z.array(
		z.object({
			memberId: z.string(),
			displayName: z.string(),
			state: z.string(),
		}),
	),
});

function record(memberId: string, displayName: string, state: MemberState) {
	return create(SignedEnvelopeSchema, {
		context: MEMBER_RECORD_CONTEXT,
		keyId: "authority#1",
		payload: toBinary(
			MemberRecordSchema,
			create(MemberRecordSchema, {
				memberId,
				tenant: "hobo-labs",
				kind: MemberKind.DEVICE,
				displayName,
				state,
				memberships: [
					{
						fleet: "hobo",
						name: displayName,
						roles: [Role.DISPATCHER, Role.EXECUTOR],
					},
				],
			}),
		),
		signature: new Uint8Array(64),
	});
}

const MEMBERS = create(MemberListSchema, {
	members: [
		record(BOX_A, "box-a", MemberState.ACTIVE),
		record(BOX_B, "box-b", MemberState.SUSPENDED),
	],
});
const VIEW = create(FleetViewSchema, {
	fleet: "hobo",
	members: [
		{
			memberId: BOX_A,
			name: "box-a",
			state: MemberState.ACTIVE,
			availability: Availability.LIVE,
			capacity: { freeSlots: 2, totalSlots: 4 },
			labels: ["hobo"],
		},
	],
	capacity: { live: 1, healthy: 1, totalSlots: 4, freeSlots: 2 },
	asOf: "2026-10-26T12:00:00Z",
	notAfter: "2026-10-26T12:02:00Z",
});
const VERDICT = create(FleetVerdictSchema, {
	fleet: "hobo",
	label: "hobo-trunk",
	state: VerdictState.OPEN,
	members: 1,
	freeSlots: 2,
	asOf: "2026-10-26T12:00:00Z",
	expiresAt: "2026-10-26T12:05:00Z",
});

const REFUSED: FleetFailure = {
	code: "forbidden",
	message: "this test answers no other method",
};

/**
 * A `FleetClient` that records every method called, answers the three reads
 * from the fixtures above and refuses everything else.
 */
function recordingFleetClient(
	answers: Readonly<{ members?: Outcome<typeof MEMBERS> }> = {},
) {
	const calls: string[] = [];
	const refuse =
		(name: string) =>
		async <Request>(_request: Request): Promise<Outcome<never>> => {
			calls.push(name);
			return { ok: false, error: REFUSED };
		};
	const client: FleetClient = {
		authorityDiscovery: refuse("authorityDiscovery"),
		discovery: refuse("discovery"),
		jwks: refuse("jwks"),
		signInStart: refuse("signInStart"),
		signInComplete: refuse("signInComplete"),
		signInPoll: refuse("signInPoll"),
		signInRefresh: refuse("signInRefresh"),
		issueToken: refuse("issueToken"),
		listTokens: refuse("listTokens"),
		revokeToken: refuse("revokeToken"),
		enroll: refuse("enroll"),
		declare: refuse("declare"),
		approveKey: refuse("approveKey"),
		accept: refuse("accept"),
		reject: refuse("reject"),
		suspend: refuse("suspend"),
		resume: refuse("resume"),
		unlock: refuse("unlock"),
		revoke: refuse("revoke"),
		assign: refuse("assign"),
		credentials: refuse("credentials"),
		rotateKeys: refuse("rotateKeys"),
		leave: refuse("leave"),
		listMembers: async (request) => {
			calls.push(`listMembers:${request.fleet ?? ""}`);
			return answers.members ?? { ok: true, value: MEMBERS };
		},
		getMember: refuse("getMember"),
		listFleets: refuse("listFleets"),
		getFleet: refuse("getFleet"),
		defineFleet: refuse("defineFleet"),
		fleetView: async (request) => {
			calls.push(`fleetView:${request.fleetId}`);
			return {
				ok: true,
				value: create(SignedEnvelopeSchema, {
					context: FLEET_VIEW_CONTEXT,
					keyId: "authority#1",
					payload: toBinary(FleetViewSchema, VIEW),
					signature: new Uint8Array(64),
				}),
			};
		},
		fleetVerdict: async (request) => {
			calls.push(`fleetVerdict:${request.fleetId}:${request.label}`);
			return { ok: true, value: VERDICT };
		},
		grantSession: refuse("grantSession"),
		submitWork: refuse("submitWork"),
		workStatus: refuse("workStatus"),
		workLogs: refuse("workLogs"),
		report: refuse("report"),
		auditCheckpoints: refuse("auditCheckpoints"),
		auditEntries: refuse("auditEntries"),
	};
	return { client, calls };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const authenticate: RelayMcpOptions["authenticate"] = (presented) => {
	const scopes = SCOPES.get(presented ?? "");
	return scopes
		? { accountId: "account-a", installationIds: [10], scopes }
		: undefined;
};

/** The relay's control plane and MCP server over one store, reading `fleet`. */
async function relay(fleet?: RelayFleet) {
	const store = new SqliteCiStore(":memory:");
	await store.configure(config(), 0, NOW);
	const github = {
		appRequest: async () => new Response(null, { status: 500 }),
		request: async () => new Response(null, { status: 500 }),
	};
	const control = createHostedControlPlane({
		relay: new HostedRelay({
			config: config(),
			store,
			github,
			identity: {
				verify: async () => {
					throw new Error("unexpected runner identity request");
				},
			},
			webhookSecret: SECRET,
			now: () => NOW,
		}),
		store,
		github,
		authenticate,
		publicOrigin: ORIGIN,
		assets: relayInstallAssets(),
		fleet,
	});
	const mcp = createRelayMcp({
		store,
		relay: async () => ({ reconcile: async () => undefined }),
		authenticate,
		ready: async () => true,
		fleet,
		publicOrigin: ORIGIN,
		sessions: "none",
		cursorSecret: SECRET,
	});
	const handle = createRelayHandler({
		application: {
			ingestWebhook: async () => "accepted",
			claim: async () => new Response(null, { status: 403 }),
			control,
			ready: async () => true,
			mcp: mcp.handle,
		},
		webhookSecret: SECRET,
	});
	closers.push(async () => {
		await mcp.close();
		store.close();
	});
	/** One request to the control plane, as the HTTP host hands it on. */
	const get = async (path: string, authorization?: string, method = "GET") =>
		(await control(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: authorization ? { authorization } : {},
			}),
		)) ?? new Response(null, { status: 404 });
	async function connect(authorization: string) {
		const client = new Client({ name: "fleet-surfaces", version: "1.0.0" });
		await client.connect(
			new StreamableHTTPClientTransport(new URL("/mcp", ORIGIN), {
				fetch: (url, init) => handle(new Request(url, init)),
				requestInit: { headers: { authorization } },
			}),
		);
		closers.push(() => client.close());
		return {
			client,
			call: async (name: string, input: Record<string, string> = {}) =>
				Structured.parse(await client.callTool({ name, arguments: input })),
			read: async (uri: string) =>
				Contents.parse(await client.readResource({ uri })),
		};
	}
	return { get, connect, control };
}

describe(`GET ${RELAY_FLEET_MEMBERS_PATH}`, () => {
	it("is authenticated like the account API's other reads, and only read", async () => {
		const fake = recordingFleetClient();
		const h = await relay({ reads: fake.client, fleetId: HOBO });
		const unauthenticated = await h.get(RELAY_FLEET_MEMBERS_PATH);
		expect(unauthenticated.status).toBe(401);
		expect(await unauthenticated.json()).toEqual({
			error: "account authentication required",
		});
		expect((await h.get(RELAY_FLEET_MEMBERS_PATH, WRITER)).status).toBe(403);
		expect((await h.get(RELAY_FLEET_MEMBERS_PATH, OPERATOR)).status).toBe(403);
		// A write is never routed to the authority, whatever the credential may do.
		expect((await h.get(RELAY_FLEET_MEMBERS_PATH, READER, "POST")).status).toBe(
			403,
		);
		expect(
			(await h.get(`${RELAY_FLEET_MEMBERS_PATH}/${BOX_A}`, READER)).status,
		).toBe(404);
		expect(fake.calls).toEqual([]);
	});

	it("answers the authority's signed member list for the relay's fleet", async () => {
		const fake = recordingFleetClient();
		const h = await relay({ reads: fake.client, fleetId: HOBO });
		const response = await h.get(RELAY_FLEET_MEMBERS_PATH, READER);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json");
		const body = fromJsonString(MemberListSchema, await response.text());
		expect(body).toEqual(MEMBERS);
		expect(fake.calls).toEqual(["listMembers:hobo"]);
	});

	it("says the relay reads no fleet, and why the authority refused", async () => {
		const none = await relay();
		const unconfigured = await none.get(RELAY_FLEET_MEMBERS_PATH, READER);
		expect(unconfigured.status).toBe(503);
		expect(await unconfigured.json()).toEqual({
			error: "this relay reads no fleet",
		});
		const refused = recordingFleetClient({
			members: { ok: false, error: { code: "unavailable", message: "down" } },
		});
		const h = await relay({ reads: refused.client, fleetId: HOBO });
		const answer = await h.get(RELAY_FLEET_MEMBERS_PATH, READER);
		expect(answer.status).toBe(503);
		// The code, never the authority's own words.
		expect(await answer.json()).toEqual({
			error: "the fleet authority refused the read (unavailable)",
		});
	});

	it("is what the relay client reads", async () => {
		const fake = recordingFleetClient();
		const h = await relay({ reads: fake.client, fleetId: HOBO });
		const client = createCiRelayClient({
			origin: ORIGIN,
			fetch: async (input, init) =>
				h.get(
					new URL(`${input}`).pathname,
					new Headers(init?.headers).get("authorization") ?? undefined,
				),
			accountToken: () => READER.slice("Bearer ".length),
		});
		expect(await client.getFleetMembers()).toEqual(MEMBERS);
		expect(fake.calls).toEqual(["listMembers:hobo"]);
	});

	it("no longer answers the mesh's or the hosted verdict's routes", async () => {
		const h = await relay({
			reads: recordingFleetClient().client,
			fleetId: HOBO,
		});
		for (const path of [
			"/v1/mesh/nodes",
			"/v1/fleet/verdicts/org/repo",
			"/v1/fleet/reporters/org/repo",
		])
			expect(await h.control(new Request(`${ORIGIN}${path}`))).toBeUndefined();
	});
});

describe("the MCP server's fleet tools and hobo-ci://fleet/members", () => {
	it("answers every fleet tool and the resource from the client, and calls nothing that writes", async () => {
		const fake = recordingFleetClient();
		const h = await relay({ reads: fake.client, fleetId: HOBO });
		const mcp = await h.connect(READER);
		const tools = (await mcp.client.listTools()).tools.map((tool) => tool.name);
		expect(tools).toEqual(
			expect.arrayContaining([
				"list_fleet_members",
				"get_fleet_view",
				"get_fleet_verdict",
			]),
		);
		expect(tools.filter((name) => name.includes("mesh"))).toEqual([]);
		const fleetTools = (await mcp.client.listTools()).tools.filter((tool) =>
			tool.name.includes("fleet"),
		);
		for (const tool of fleetTools)
			expect(tool.annotations?.readOnlyHint).toBe(true);
		expect(
			(await mcp.client.listResources()).resources.map((entry) => entry.uri),
		).toEqual(expect.arrayContaining(["hobo-ci://fleet/members"]));

		const listed = await mcp.call("list_fleet_members");
		expect(listed.isError).toBeUndefined();
		const members = Members.parse(listed.structuredContent);
		expect(members).toMatchObject({ configured: true, fleet: "hobo" });
		expect(
			members.members.map((member) => [
				member.memberId,
				member.displayName,
				member.state,
			]),
		).toEqual([
			[BOX_A, "box-a", "MEMBER_STATE_ACTIVE"],
			[BOX_B, "box-b", "MEMBER_STATE_SUSPENDED"],
		]);
		const viaResource = Members.parse(
			JSON.parse(
				(await mcp.read("hobo-ci://fleet/members")).contents[0]?.text ?? "",
			),
		);
		expect(viaResource).toEqual(members);

		const view = await mcp.call("get_fleet_view");
		expect(view.isError).toBeUndefined();
		expect(
			fromJsonString(FleetViewSchema, view.content[0]?.text ?? ""),
		).toEqual(VIEW);
		const verdict = await mcp.call("get_fleet_verdict", {
			label: "hobo-trunk",
		});
		expect(verdict.isError).toBeUndefined();
		expect(verdict.structuredContent).toMatchObject({
			fleet: "hobo",
			label: "hobo-trunk",
			state: "VERDICT_STATE_OPEN",
			freeSlots: 2,
		});
		expect(
			(await mcp.call("get_relay_status")).structuredContent,
		).toMatchObject({ mesh: "configured" });

		expect(fake.calls).toEqual([
			"listMembers:hobo",
			"listMembers:hobo",
			"fleetView:hobo",
			"fleetVerdict:hobo:hobo-trunk",
		]);
		for (const call of fake.calls) expect(READS).toContain(call.split(":")[0]);
	});

	it("answers not-configured for the members and refuses a view of no fleet", async () => {
		const h = await relay();
		const mcp = await h.connect(READER);
		const listed = await mcp.call("list_fleet_members");
		expect(listed.isError).toBeUndefined();
		expect(listed.structuredContent).toEqual({
			configured: false,
			fleet: "",
			members: [],
		});
		const view = await mcp.call("get_fleet_view");
		expect(view.isError).toBe(true);
		expect(view.content[0]?.text).toBe("this relay reads no fleet");
		const verdict = await mcp.call("get_fleet_verdict", { label: "hobo" });
		expect(verdict.isError).toBe(true);
		expect(
			(await mcp.call("get_relay_status")).structuredContent,
		).toMatchObject({ mesh: "not-configured" });
	});

	it("needs the read scope, and refuses a label that is not one", async () => {
		const fake = recordingFleetClient();
		const h = await relay({ reads: fake.client, fleetId: HOBO });
		const operator = await h.connect(OPERATOR);
		for (const name of ["list_fleet_members", "get_fleet_view"]) {
			const refused = await operator.call(name);
			expect(refused.isError).toBe(true);
			expect(refused.content[0]?.text).toBe(
				"account scope required: policy:read",
			);
		}
		await expect(operator.read("hobo-ci://fleet/members")).rejects.toThrow(
			/account scope required: policy:read/,
		);
		const reader = await h.connect(READER);
		const bad = await reader.call("get_fleet_verdict", { label: "a b" });
		expect(bad.isError).toBe(true);
		expect(fake.calls).toEqual([]);
	});
});

describe("relayFleetReads", () => {
	it("keeps only the client's reads, each a call through @hobo/fleet/client", async () => {
		const requests: string[] = [];
		const client = createFleetClient({
			origin: "https://fleet.example",
			fetch: async (input, init) => {
				requests.push(
					`${init?.method ?? "GET"} ${new URL(`${input}`).pathname}`,
				);
				return new Response(JSON.stringify({ members: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
			auth: undefined,
		});
		const reads = relayFleetReads(client);
		expect(Object.keys(reads).sort()).toEqual([...READS].sort());
		const h = await relay({ reads, fleetId: HOBO });
		const response = await h.get(RELAY_FLEET_MEMBERS_PATH, READER);
		expect(response.status).toBe(200);
		expect(requests).toEqual(["GET /v1/fleet/members"]);
	});
});
