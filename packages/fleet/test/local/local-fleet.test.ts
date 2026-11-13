// O41: local mode needs nothing else. The members and fleet a configuration
// declares are ACTIVE; a second start from the same configuration yields the
// same member ids; nothing is signed; and the test fails any socket, fetch or
// file write outside its temporary directory (§6.2 "Local mode", D6, D39).
import dgram from "node:dgram";
import fs, { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { create } from "@bufbuild/protobuf";
import { parseTenantId } from "@hobo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ApprovalMode,
	CoordinationMode,
	type FleetPolicy,
	FleetPolicySchema,
	MemberKind,
	MemberState,
} from "../../src/_generated/fleet_pb.js";
import { parseFleetId, parseMemberId, parseMemberName } from "../../src/ids.js";
import { sponsoredMemberId } from "../../src/keys/index.js";
import { createLocalFleet } from "../../src/local/index.js";
import type { FleetLogEvent, LocalFleetInit } from "../../src/ports.js";

const TENANT = parseTenantId("relay");
const FLEET = parseFleetId("cache");
const START_MS = Date.parse("2026-11-01T10:00:00.000Z");
const DIGEST = `sha256:${"ab".repeat(32)}`;

type Logged = Readonly<{ event: FleetLogEvent; subject: string }>;

function policy(
	init: Parameters<typeof create<typeof FleetPolicySchema>>[1] = {},
): FleetPolicy {
	return create(FleetPolicySchema, {
		approval: ApprovalMode.AUTO_OWNER,
		allowedKinds: [MemberKind.BACKEND],
		failoverAfterMs: 30_000,
		...init,
	});
}

function configuration(
	overrides: Partial<LocalFleetInit> = {},
	logged: Logged[] = [],
): LocalFleetInit {
	let at = START_MS;
	return {
		tenant: TENANT,
		fleetId: FLEET,
		coordination: CoordinationMode.ONE_ACTIVE,
		policy: policy(),
		owner: { kind: "service", id: "hosted-relay" },
		members: [
			{
				kind: MemberKind.BACKEND,
				name: parseMemberName("upstash"),
				displayName: "Upstash Redis",
				credentialRef: "env://UPSTASH_REDIS_REST_TOKEN",
				endpointDigest: DIGEST,
			},
			{
				kind: MemberKind.BACKEND,
				name: parseMemberName("vercel-kv"),
				displayName: "Vercel KV",
				credentialRef: "env://KV_REST_API_TOKEN",
				endpointDigest: "",
			},
		],
		now: () => (at += 1),
		log: (event, fields) =>
			logged.push({ event, subject: String(fields.subject ?? "") }),
		...overrides,
	};
}

// ── The guard: no socket, no fetch, no file write outside the temporary directory ──

type Restore = () => void;
const restores: Restore[] = [];
const violations: string[] = [];
let tempDir = "";

/** Replaces a property for the duration of one test; defineProperty, because the replacement need not match the original's overloads. */
function patch<T extends object>(
	target: T,
	key: keyof T & string,
	replacement: (...args: never[]) => void,
): void {
	const original = target[key];
	Object.defineProperty(target, key, {
		value: replacement,
		writable: true,
		configurable: true,
	});
	restores.push(() => {
		Object.defineProperty(target, key, {
			value: original,
			writable: true,
			configurable: true,
		});
	});
}

function refuse(what: string): never {
	violations.push(what);
	throw new Error(`local mode touched ${what}`);
}

function insideTemp(path: fs.PathLike): boolean {
	const absolute = resolve(String(path));
	return absolute === tempDir || absolute.startsWith(`${tempDir}${sep}`);
}

/** Every file-system write takes the path first. */
type WriteFn = (path: fs.PathLike, ...rest: never[]) => void;

function guardWrite<T extends object>(
	target: T,
	key: keyof T & string,
	original: WriteFn,
	label: string,
): void {
	patch(target, key, (path: fs.PathLike, ...rest: never[]) =>
		insideTemp(path)
			? original(path, ...rest)
			: refuse(`${label}.${key}(${String(path)})`),
	);
}

beforeEach(() => {
	violations.length = 0;
	tempDir = resolve(mkdtempSync(join(tmpdir(), "hobo-fleet-local-")));
	patch(globalThis, "fetch", async () => refuse("fetch"));
	patch(net.Socket.prototype, "connect", () => refuse("net.Socket.connect"));
	patch(net.Server.prototype, "listen", () => refuse("net.Server.listen"));
	patch(dgram, "createSocket", () => refuse("dgram.createSocket"));
	guardWrite(fs, "writeFile", fs.writeFile, "fs");
	guardWrite(fs, "writeFileSync", fs.writeFileSync, "fs");
	guardWrite(fs, "appendFile", fs.appendFile, "fs");
	guardWrite(fs, "appendFileSync", fs.appendFileSync, "fs");
	guardWrite(fs, "mkdir", fs.mkdir, "fs");
	guardWrite(fs, "mkdirSync", fs.mkdirSync, "fs");
	guardWrite(fs, "createWriteStream", fs.createWriteStream, "fs");
	guardWrite(fs, "copyFile", fs.copyFile, "fs");
	guardWrite(fs, "copyFileSync", fs.copyFileSync, "fs");
	guardWrite(fs, "rename", fs.rename, "fs");
	guardWrite(fs, "renameSync", fs.renameSync, "fs");
	guardWrite(fs, "rm", fs.rm, "fs");
	guardWrite(fs, "rmSync", fs.rmSync, "fs");
	guardWrite(fs, "unlink", fs.unlink, "fs");
	guardWrite(fs, "unlinkSync", fs.unlinkSync, "fs");
	const promises = fs.promises;
	guardWrite(promises, "writeFile", promises.writeFile, "fs.promises");
	guardWrite(promises, "appendFile", promises.appendFile, "fs.promises");
	guardWrite(promises, "mkdir", promises.mkdir, "fs.promises");
	guardWrite(promises, "copyFile", promises.copyFile, "fs.promises");
	guardWrite(promises, "rename", promises.rename, "fs.promises");
	guardWrite(promises, "rm", promises.rm, "fs.promises");
	guardWrite(promises, "unlink", promises.unlink, "fs.promises");
});

afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	rmSync(tempDir, { recursive: true, force: true });
	expect(violations).toEqual([]);
});

describe("createLocalFleet (O41)", () => {
	it("the guard refuses a fetch, a socket and a write outside the temporary directory", async () => {
		await expect(fetch("https://example.test/")).rejects.toThrow(
			"local mode touched fetch",
		);
		expect(() => net.connect(443, "example.test")).toThrow(
			"local mode touched net.Socket.connect",
		);
		expect(() => fs.writeFileSync(join(tmpdir(), "outside.txt"), "x")).toThrow(
			"local mode touched fs.writeFileSync",
		);
		fs.writeFileSync(join(tempDir, "inside.txt"), "x");
		expect(fs.readFileSync(join(tempDir, "inside.txt"), "utf8")).toBe("x");
		violations.length = 0;
	});

	it("declares the configured fleet and every configured member ACTIVE", async () => {
		const logged: Logged[] = [];
		const init = configuration({}, logged);
		const { registry, fleet, members } = await createLocalFleet(init);

		expect(fleet.fleetId).toBe(FLEET);
		expect(fleet.tenant).toBe(TENANT);
		expect(fleet.coordination).toBe(CoordinationMode.ONE_ACTIVE);
		expect(fleet.owner).toBe("service:hosted-relay");
		expect(fleet.revision).toBe(1);
		expect(fleet.policy?.approval).toBe(ApprovalMode.AUTO_OWNER);

		expect(members.map((member) => member.memberships[0]?.name)).toEqual([
			"upstash",
			"vercel-kv",
		]);
		expect(members).toHaveLength(init.members.length);
		for (const [i, configured] of init.members.entries()) {
			const member = members[i];
			if (member === undefined) throw new Error(`no member ${i}`);
			expect(member.state).toBe(MemberState.ACTIVE);
			expect(member.kind).toBe(MemberKind.BACKEND);
			expect(member.tenant).toBe(TENANT);
			expect(member.memberId).toBe(
				sponsoredMemberId(TENANT, MemberKind.BACKEND, FLEET, configured.name),
			);
			expect(member.displayName).toBe(configured.displayName);
			expect(member.credentialRef).toBe(configured.credentialRef);
			expect(member.endpointDigest).toBe(configured.endpointDigest);
			expect(member.sponsor).toBe("service:hosted-relay");
			expect(member.owner).toBe("service:hosted-relay");
			expect(member.keyApprovedBy).toBe("service:hosted-relay");
			expect(member.acceptedBy).toBe("service:hosted-relay");
		}

		// The in-process registry holds the same records.
		expect(await registry.fleet(FLEET)).toEqual(fleet);
		expect(await registry.fleets()).toEqual([fleet]);
		for (const member of members) {
			expect(await registry.member(parseMemberId(member.memberId))).toEqual(
				member,
			);
		}
		// One-active: the registry lists the configured members as candidates.
		expect(
			(await registry.membersOf(FLEET)).map((member) => member.memberId),
		).toEqual(members.map((member) => member.memberId));
		expect(await registry.members()).toEqual(members);
		expect(await registry.fleet(parseFleetId("other"))).toBeUndefined();
		expect(await registry.membersOf(parseFleetId("other"))).toEqual([]);
		await registry.caughtUp();

		// The same state machine ran: declared, approved, accepted, activated.
		expect(logged.map((entry) => entry.event)).toContain(
			"hobo_fleet_member_activated",
		);
	});

	it("a second start from the same configuration yields the same member ids", async () => {
		const first = await createLocalFleet(configuration());
		const second = await createLocalFleet(configuration());
		expect(second.members.map((member) => member.memberId)).toEqual(
			first.members.map((member) => member.memberId),
		);
		expect(second.fleet.fleetId).toBe(first.fleet.fleetId);
	});

	it("signs nothing: no trust envelope, no keys, no signing-time fields", async () => {
		const { registry, fleet, members } = await createLocalFleet(
			configuration(),
		);
		expect(registry.trustEnvelope()).toBeUndefined();
		const trust = registry.trust();
		expect(trust.tenant).toBe(TENANT);
		expect(trust.authorityKeys).toEqual([]);
		expect(trust.witnessKeys).toEqual([]);
		expect(fleet.issuedAt).toBe("");
		expect(fleet.notAfter).toBe("");
		for (const member of members) {
			expect(member.issuedAt).toBe("");
			expect(member.notAfter).toBe("");
			expect(member.authorityIncarnation).toBe(0);
		}
	});

	it("accepts ONE_ACTIVE and MANY_ACTIVE fleets alike (mode local)", async () => {
		const many = await createLocalFleet(
			configuration({
				coordination: CoordinationMode.MANY_ACTIVE,
				policy: policy({ failoverAfterMs: 0 }),
			}),
		);
		expect(many.fleet.coordination).toBe(CoordinationMode.MANY_ACTIVE);
		expect(many.members.every((m) => m.state === MemberState.ACTIVE)).toBe(
			true,
		);
	});

	it("an unset approval mode is the owner's AUTO_OWNER", async () => {
		const { fleet, members } = await createLocalFleet(
			configuration({ policy: policy({ approval: ApprovalMode.UNSPECIFIED }) }),
		);
		expect(fleet.policy?.approval).toBe(ApprovalMode.AUTO_OWNER);
		expect(members.every((m) => m.state === MemberState.ACTIVE)).toBe(true);
	});

	it("refuses an approval mode that would need another principal", async () => {
		for (const approval of [ApprovalMode.SINGLE, ApprovalMode.DUAL])
			await expect(
				createLocalFleet(configuration({ policy: policy({ approval }) })),
			).rejects.toThrow(/fleet-policy.*local-approval/u);
	});

	it("refuses a configuration the fleet policy refuses", async () => {
		await expect(
			createLocalFleet(
				configuration({ policy: policy({ failoverAfterMs: 0 }) }),
			),
		).rejects.toThrow(/invalid-request.*failover-after/u);
		await expect(
			createLocalFleet(
				configuration({
					members: [
						{
							kind: MemberKind.DEVICE,
							name: parseMemberName("laptop"),
							displayName: "Laptop",
							credentialRef: "",
							endpointDigest: "",
						},
					],
				}),
			),
		).rejects.toThrow(/invalid-request/u);
		await expect(
			createLocalFleet(
				configuration({
					members: [
						{
							kind: MemberKind.BACKEND,
							name: parseMemberName("dup"),
							displayName: "One",
							credentialRef: "",
							endpointDigest: "",
						},
						{
							kind: MemberKind.BACKEND,
							name: parseMemberName("dup"),
							displayName: "Two",
							credentialRef: "",
							endpointDigest: "",
						},
					],
				}),
			),
		).rejects.toThrow(/invalid-request.*duplicate-name/u);
	});

	it("an empty configuration declares the fleet with no members", async () => {
		const { registry, members } = await createLocalFleet(
			configuration({ members: [] }),
		);
		expect(members).toEqual([]);
		expect(await registry.membersOf(FLEET)).toEqual([]);
	});
});
