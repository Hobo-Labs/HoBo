/**
 * Steps for features/fleet/enroll-and-run.feature (O2, in-memory bus):
 * enrollment by bootstrap token, by the person's browser approval, by a
 * workload identity, dual-control approval, a declared backend, and the
 * developer's own `oci-command` job reaching a SUCCEEDED receipt.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	ApprovalMode,
	browserApproval,
	create,
	DeclareRequestSchema,
	DeviceClass,
	decodeMember,
	enrollDevice,
	finalReceipt,
	LifecycleRequestSchema,
	MemberKind,
	MemberState,
	OidcTrustRuleSchema,
	parseFleetId,
	parseMemberName,
	ReceiptStatus,
	Role,
	SessionPurpose,
	sponsoredMemberId,
	submitJob,
	TENANT,
	TokenCreateRequestSchema,
	WORKLOAD_ISSUER,
	WORKLOAD_TOKEN,
	watchReceipts,
} from "../../../packages/fleet-authority/acceptance/index.js";
import { device, fleet, startWorld, world } from "./state.js";

const BOTH = [Role.DISPATCHER, Role.EXECUTOR];

Given("a fleet authority on the in-memory bus", async () => {
	await startWorld();
});

Given("the developer owns the many-active fleet {string} with owner approval", async (id: string) => {
	await world().defineFleet(id, "dev", { workKinds: ["oci-command"], sessionPurposes: [SessionPurpose.SHELL] });
});

Given("alice owns the many-active fleet {string} with dual-control approval", async (id: string) => {
	await world().defineFleet(id, "alice", { approval: ApprovalMode.DUAL });
});

Given("the fleet {string} trusts workload identities of {string}", async (id: string, repository: string) => {
	await world().defineFleet(id, "dev", {
		approval: ApprovalMode.SINGLE,
		oidcTrust: [
			create(OidcTrustRuleSchema, {
				issuer: WORKLOAD_ISSUER,
				subjectPattern: `repo:${repository.split("/")[0]}/.*`,
				requiredClaims: { repository },
				roles: [Role.EXECUTOR],
			}),
		],
	});
});

When("the developer's device {string} enrolls in {string} with a bootstrap token", async (name: string, id: string) => {
	const w = world();
	const token = await w.token(id, name, BOTH);
	fleet.notes.set("token", token);
	fleet.device = await enrollDevice(w, {
		fleet: id,
		name,
		roles: BOTH,
		proof: async () => ({ case: "bootstrapToken", value: token }),
	});
	fleet.notes.set("fleet", id);
});

When("the device {string} enrolls in {string} with a bootstrap token from alice", async (name: string, id: string) => {
	const w = world();
	const token = await w.token(id, name, [Role.EXECUTOR], "alice");
	fleet.device = await enrollDevice(w, {
		fleet: id,
		name,
		roles: [Role.EXECUTOR],
		proof: async () => ({ case: "bootstrapToken", value: token }),
	});
});

When(
	"the developer's device {string} enrolls in {string} through the developer's browser approval",
	async (name: string, id: string) => {
		const w = world();
		fleet.device = await enrollDevice(w, {
			fleet: id,
			name,
			roles: BOTH,
			deviceClass: DeviceClass.PERSONAL,
			proof: (keys) => browserApproval(w, "dev", keys),
		});
		fleet.notes.set("fleet", id);
	},
);

When("a CI runner {string} enrolls in {string} with its workload identity token", async (name: string, id: string) => {
	fleet.device = await enrollDevice(world(), {
		fleet: id,
		name,
		roles: [Role.EXECUTOR],
		deviceClass: DeviceClass.EPHEMERAL,
		proof: async () => ({ case: "oidcAssertion", value: WORKLOAD_TOKEN }),
	});
	fleet.notes.set("fleet", id);
});

async function registered() {
	const enrolled = device();
	assert.ok(enrolled.response.ok, enrolled.response.ok ? "" : `${enrolled.response.error.code}: ${enrolled.response.error.message}`);
	const self = await enrolled.keys.open();
	await world().runtime.tickOnce();
	const record = await world().bus.registry.member(self.memberId);
	assert.ok(record !== undefined, "the registry has no record of the device");
	return record;
}

Then("the device is ACTIVE in the registry", async () => {
	assert.equal(MemberState[(await registered()).state], "ACTIVE");
});

Then("the device is PENDING in the registry", async () => {
	assert.equal(MemberState[(await registered()).state], "PENDING");
});

Then("the device is ACTIVE in the registry as an EPHEMERAL device", async () => {
	const record = await registered();
	assert.equal(MemberState[record.state], "ACTIVE");
	assert.equal(DeviceClass[record.deviceClass], "EPHEMERAL");
});

Then("the bootstrap token cannot enroll a second device", async () => {
	const w = world();
	const token = fleet.notes.get("token") ?? "";
	const thief = await enrollDevice(w, {
		fleet: fleet.notes.get("fleet") ?? "",
		name: "thief",
		roles: BOTH,
		proof: async () => ({ case: "bootstrapToken", value: token }),
	});
	assert.equal(thief.response.ok ? "ok" : thief.response.error.code, "token-used");
});

Then("the same workload token cannot enroll another runner", async () => {
	const again = await enrollDevice(world(), {
		fleet: fleet.notes.get("fleet") ?? "",
		name: "runner-2",
		roles: [Role.EXECUTOR],
		deviceClass: DeviceClass.EPHEMERAL,
		proof: async () => ({ case: "oidcAssertion", value: WORKLOAD_TOKEN }),
	});
	assert.equal(again.response.ok ? "ok" : again.response.error.code, "proof-replayed");
});

When("the device starts and the developer submits the job {string} to {string}", async (command: string, id: string) => {
	const w = world();
	const receipts = watchReceipts(w);
	await device().agent.start();
	const submitted = await submitJob(w, "dev", id, command.split(" "));
	const receipt = await finalReceipt(receipts, submitted, 45_000);
	fleet.notes.set("receipt-status", ReceiptStatus[receipt.status] ?? String(receipt.status));
	fleet.notes.set("receipt-member", receipt.memberId);
	fleet.notes.set("receipt-reason", receipt.reason);
});

Then("the job reaches a SUCCEEDED receipt from the device", async () => {
	const self = await device().keys.open();
	assert.equal(fleet.notes.get("receipt-status"), "SUCCEEDED", `receipt reason: ${fleet.notes.get("receipt-reason")}`);
	assert.equal(fleet.notes.get("receipt-member"), self.memberId);
});

async function lifecycle(action: "approveKey" | "accept", by: "alice" | "bob") {
	const w = world();
	const { caller } = await w.person(by);
	const self = await device().keys.open();
	const answer = await w.authority[action](
		{ memberId: self.memberId, request: create(LifecycleRequestSchema, { reason: "acceptance" }) },
		caller,
	);
	fleet.refusal = answer.ok ? undefined : `${answer.error.code}:${answer.error.detail?.rule ?? ""}`;
	await w.runtime.tickOnce();
}

When("alice approves the device's key", async () => {
	await lifecycle("approveKey", "alice");
	assert.equal(fleet.refusal, undefined);
});

When("alice tries to accept the device herself", async () => {
	await lifecycle("accept", "alice");
});

Then("the acceptance is refused by the dual-control rule", () => {
	assert.equal(fleet.refusal, "fleet-policy:dual-control");
});

When("bob accepts the device", async () => {
	await lifecycle("accept", "bob");
	assert.equal(fleet.refusal, undefined);
});

When("the developer declares the backend {string} into {string}", async (name: string, id: string) => {
	const w = world();
	const { caller } = await w.person("dev");
	const declared = await w.authority.declare(
		create(DeclareRequestSchema, {
			fleet: id,
			kind: MemberKind.BACKEND,
			name,
			credentialRef: `secret://${id}/${name}`,
			endpointDigest: `sha256:${"a".repeat(64)}`,
		}),
		caller,
	);
	assert.ok(declared.ok, declared.ok ? "" : declared.error.message);
	const record = decodeMember(declared);
	assert.ok(record !== undefined);
	fleet.notes.set("backend", record.memberId);
	fleet.notes.set("backend-name", name);
	fleet.notes.set("fleet", id);
});

Then("the backend is ACTIVE in the registry under its sponsored member id", async () => {
	const w = world();
	const id = fleet.notes.get("fleet") ?? "";
	const memberId = fleet.notes.get("backend") ?? "";
	assert.equal(
		memberId,
		sponsoredMemberId(TENANT, MemberKind.BACKEND, parseFleetId(id), parseMemberName(fleet.notes.get("backend-name") ?? "")),
	);
	await w.runtime.tickOnce();
	const record = await w.bus.registry.member(sponsoredMemberId(TENANT, MemberKind.BACKEND, parseFleetId(id), parseMemberName("redis")));
	assert.equal(record === undefined ? "absent" : MemberState[record.state], "ACTIVE");
	assert.equal(record?.sponsor, "user:dev");
});

Then("a second member named {string} in {string} is refused as name-taken", async (name: string, id: string) => {
	const w = world();
	const { caller } = await w.person("dev");
	const token = await w.authority.issueToken(create(TokenCreateRequestSchema, { fleet: id, name, ttlSeconds: 900 }), caller);
	assert.equal(token.ok ? "ok" : token.error.code, "name-taken");
});
