// L19 TARGET declaration: the Station declares each agentless Camp of a mapped
// Yard as a TARGET member of the fleet named after the Yard, through
// `members:declare`; a Camp a reconciler DEVICE already backs is left alone.
import { create } from "@bufbuild/protobuf";
import { parseTenantId } from "@hobo/core";
import {
	type DeclareRequest,
	EnrollmentResponseSchema,
	type FleetClient,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	MembershipSchema,
	parseFleetId,
	parseMemberName,
} from "@hobo/fleet";
import { sponsoredMemberId } from "@hobo/fleet/keys";
import { describe, expect, it } from "vitest";
import {
	createCampTargetDeclarer,
	declareCampTarget,
} from "../../src/inventory/index.js";
import { camp, FakeTopology, topology } from "./fakes.js";

const TENANT = parseTenantId("acme");

function recordingClient(fail = false) {
	const declared: DeclareRequest[] = [];
	const client: Pick<FleetClient, "declare"> = {
		async declare(request) {
			declared.push(request);
			return fail
				? { ok: false, error: { code: "unauthenticated", message: "no rule" } }
				: { ok: true, value: create(EnrollmentResponseSchema, {}) };
		},
	};
	return { client, declared };
}

function device(name: string): MemberRecord {
	return create(MemberRecordSchema, {
		memberId: `dev_${"c".repeat(32)}`,
		tenant: TENANT,
		kind: MemberKind.DEVICE,
		state: MemberState.ACTIVE,
		memberships: [create(MembershipSchema, { fleet: "yard-a", name })],
	});
}

describe("TARGET declaration (L19)", () => {
	it("declares one Camp as a TARGET with its sponsored member id", async () => {
		const { client, declared } = recordingClient();
		const result = await declareCampTarget(client, {
			tenant: TENANT,
			fleet: "yard-a",
			campId: camp("yard-a/Eu.1"),
			displayName: "yard-a/Eu.1",
			credentialRef: "",
			endpointDigest: "",
		});
		expect(result).toEqual({
			ok: true,
			value: sponsoredMemberId(
				TENANT,
				MemberKind.TARGET,
				parseFleetId("yard-a"),
				parseMemberName("eu-1"),
			),
		});
		expect(declared.map((r) => [r.tenant, r.fleet, r.kind, r.name])).toEqual([
			["acme", "yard-a", MemberKind.TARGET, "eu-1"],
		]);
	});

	it("a refused declaration is a typed refusal, not a throw", async () => {
		const { client } = recordingClient(true);
		const result = await declareCampTarget(client, {
			tenant: TENANT,
			fleet: "yard-a",
			campId: camp("eu-1"),
			displayName: "eu-1",
			credentialRef: "",
			endpointDigest: "",
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.reasons[0]?.code).toBe("camp-target-declare-refused");
	});

	it("the Station declares only agentless Camps of mapped Yards", async () => {
		const { client, declared } = recordingClient();
		const declarer = createCampTargetDeclarer({
			tenant: TENANT,
			client,
			topology: new FakeTopology([
				topology("eu-1"),
				topology("eu-2"),
				topology("other-1", { yardId: "yard-b" }),
			]),
			members: {
				registry: {
					async membersOf() {
						return [device("eu-2")];
					},
					async view() {
						return undefined;
					},
				},
				fleetOf: (yardId) => (yardId === "yard-a" ? "yard-a" : undefined),
			},
		});
		const results = await declarer.declare();
		expect(results.map((r) => r.ok)).toEqual([true]);
		expect(declared.map((r) => r.name)).toEqual(["eu-1"]);
	});
});
