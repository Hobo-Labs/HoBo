/**
 * Environment memberships bound to a device are fleet memberships (L14,
 * ledger §8.3): `EnvMembershipService` takes the fleet `RegistryView`, and a
 * membership whose member is not `ACTIVE` there is absent, so a suspended or
 * revoked device loses its environment at the next decision.
 */
import { parseTenantId } from "@hobo/core";
import {
	type MemberId,
	type MemberRecord,
	MemberState,
	parseMemberId,
	type RegistryView,
} from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	createTagAclPolicyEngine,
	EnvMembershipService,
} from "../src/index.js";

const DEVICE = parseMemberId(`dev_${"a".repeat(32)}`);
const OTHER = parseMemberId(`dev_${"b".repeat(32)}`);

/** A registry double answering only `member`, from a mutable state table. */
function registry(states: Map<MemberId, MemberState>): RegistryView {
	const refuse = () => Promise.reject(new Error("not used by the service"));
	return {
		async member(id) {
			const state = states.get(id);
			if (state === undefined) return undefined;
			if (state === MemberState.UNSPECIFIED)
				throw new Error("registry unavailable");
			// SAFETY: EnvMembershipService reads only `state` of a member record.
			return {
				$typeName: "hobo.fleet.v1.MemberRecord",
				memberId: id,
				state,
			} as MemberRecord;
		},
		fleet: refuse,
		membersOf: refuse,
		fleets: refuse,
		members: refuse,
		view: refuse,
		trust() {
			throw new Error("not used by the service");
		},
		trustEnvelope: () => undefined,
		caughtUp: async () => undefined,
	};
}

function assignDevice(service: EnvMembershipService, nodeId = DEVICE) {
	return service.assign({
		principalId: "agent:runner-1",
		isolationClass: "staging",
		assignedBy: "cp-admin",
		nodeId,
	});
}

describe("EnvMembershipService over the fleet registry", () => {
	it("keeps the member id on the membership", () => {
		const service = new EnvMembershipService({ tenant: "acme" });
		expect(assignDevice(service).nodeId).toBe(DEVICE);
	});

	it("counts a device membership only while the member is ACTIVE", async () => {
		const states = new Map([[DEVICE, MemberState.ACTIVE]]);
		const service = new EnvMembershipService({
			tenant: "acme",
			registry: registry(states),
		});
		assignDevice(service);
		expect(service.getActive("agent:runner-1", "staging")).toBeNull();

		await service.refresh();
		expect(service.getActive("agent:runner-1", "staging")?.nodeId).toBe(DEVICE);

		for (const state of [
			MemberState.SUSPENDED,
			MemberState.REVOKED,
			MemberState.LOCKED,
			MemberState.PENDING,
		]) {
			states.set(DEVICE, state);
			await service.refresh();
			expect(service.getActive("agent:runner-1", "staging")).toBeNull();
			expect(service.resolveClass("agent:runner-1")).toBeNull();
		}
	});

	it("treats a member the registry does not know, or cannot answer for, as absent", async () => {
		const states = new Map([[OTHER, MemberState.UNSPECIFIED]]);
		const service = new EnvMembershipService({
			tenant: "acme",
			registry: registry(states),
		});
		assignDevice(service);
		service.assign({
			principalId: "agent:runner-2",
			isolationClass: "staging",
			assignedBy: "cp-admin",
			nodeId: OTHER,
		});
		await service.refresh();
		expect(service.getActive("agent:runner-1", "staging")).toBeNull();
		expect(service.getActive("agent:runner-2", "staging")).toBeNull();
	});

	it("without a registry, a device membership is absent and a principal one is unaffected", async () => {
		const service = new EnvMembershipService({ tenant: "acme" });
		assignDevice(service);
		service.assign({
			principalId: "user:alice",
			isolationClass: "staging",
			assignedBy: "cp-admin",
		});
		await service.refresh();
		expect(service.getActive("agent:runner-1", "staging")).toBeNull();
		expect(service.getActive("user:alice", "staging")?.principalId).toBe(
			"user:alice",
		);
	});

	it("the policy engine reads the registry at each decision", async () => {
		const states = new Map([[DEVICE, MemberState.ACTIVE]]);
		const membership = new EnvMembershipService({
			tenant: "acme",
			registry: registry(states),
		});
		assignDevice(membership);
		const engine = createTagAclPolicyEngine({
			envIsolation: { membership, enforceMembershipIntegrity: true },
		});
		const request = {
			subject: {
				identity: "agent:runner-1",
				tenantId: parseTenantId("acme"),
				tags: ["env:staging"],
			},
			resource: {
				kind: "service",
				id: "svc:api",
				tenantId: parseTenantId("acme"),
				tags: ["env:staging"],
			},
			action: "connect",
		};
		expect((await engine.evaluate(request)).effect).toBe("allow");
		states.set(DEVICE, MemberState.SUSPENDED);
		expect((await engine.evaluate(request)).effect).toBe("deny");
	});
});
