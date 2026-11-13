/**
 * The device side of the `hobo fleet` runtime against a scripted authority
 * (`fetch`): enrollment through the agent, device credentials before a device
 * call, key rotation, and the refusals before anything is composed.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary, toJsonString } from "@bufbuild/protobuf";
import {
	CredentialResponseSchema,
	DiscoverySchema,
	EnrollmentResponseSchema,
	KeyBundleSchema,
	MemberRecordSchema,
	SignedEnvelopeSchema,
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { afterEach, describe, expect, it } from "vitest";
import { createFleetRuntime } from "../src/fleet-runtime.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporary(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hobo-fleet-device-"));
	directories.push(path);
	return path;
}

const quiet = () => undefined;

function memberEnvelope(memberId: string, sequence: number) {
	const bundle = create(SignedEnvelopeSchema, {
		payload: toBinary(
			KeyBundleSchema,
			create(KeyBundleSchema, {
				memberId,
				sequence,
				issuedAt: "2026-11-13T00:00:00.000Z",
				notAfter: "2026-11-13T02:00:00.000Z",
			}),
		),
	});
	return create(SignedEnvelopeSchema, {
		payload: toBinary(
			MemberRecordSchema,
			create(MemberRecordSchema, {
				memberId,
				tenant: "acme",
				displayName: "box",
				keyBundle: bundle,
			}),
		),
	});
}

/** An authority that answers credentials for whichever member asks, and records every request. */
function authority(requests: string[], options: { refuse?: boolean } = {}) {
	return async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
		if (options.refuse)
			return Response.json(
				{ code: "forbidden", message: "not you" },
				{ status: 403 },
			);
		const credentials = /^\/v1\/fleet\/members\/([^/]+)\/credentials$/.exec(
			url.pathname,
		);
		if (credentials !== null)
			return new Response(
				toJsonString(
					CredentialResponseSchema,
					create(CredentialResponseSchema, {
						svid: "svid-1",
						generation: 2,
						memberRecord: memberEnvelope(
							decodeURIComponent(credentials[1] ?? ""),
							3,
						),
					}),
				),
				{ headers: { "content-type": "application/json" } },
			);
		if (url.pathname.endsWith("/leave"))
			return new Response(
				toJsonString(SignedEnvelopeSchema, memberEnvelope("m", 1)),
			);
		return Response.json(
			{ code: "unavailable", message: "?" },
			{ status: 503 },
		);
	};
}

describe("the device runtime", () => {
	it("enrolls through the agent, which posts the enrollment with its key bundle", async () => {
		const home = await temporary();
		const requests: string[] = [];
		const runtime = createFleetRuntime({
			env: {
				HOBO_FLEET_HOME: home,
				HOBO_FLEET_AUTHORITY_URL: "https://fleet.test",
				HOBO_FLEET_TRANSPORTS: "bus-relay",
			},
			progress: quiet,
			fetch: authority(requests, { refuse: true }),
			log: quiet,
		});
		const answer = await runtime.io.agentEnroll({
			$typeName: "hobo.fleet.v1.EnrollmentRequest",
			tenant: "acme",
			fleet: "builds",
			name: "box",
			displayName: "box",
			platform: undefined,
			region: "",
			agentVersion: "",
			deviceClass: 1,
			requestedRoles: [],
			proof: { case: "bootstrapToken", value: `hft_${"A".repeat(43)}` },
			certificateChainPem: [],
			heldKey: false,
		});
		expect(answer.ok).toBe(false);
		expect(!answer.ok && answer.error.code).toBe("forbidden");
		expect(requests).toEqual(["POST /v1/fleet/members"]);
	});

	it("refuses to run without an authority or a tenant", async () => {
		const home = await temporary();
		const noUrl = createFleetRuntime({
			env: { HOBO_FLEET_HOME: home },
			progress: quiet,
			log: quiet,
		});
		const first = await noUrl.local.startAgent({ fleets: [] });
		expect(!first.ok && first.error.message).toContain(
			"HOBO_FLEET_AUTHORITY_URL",
		);
		const noTenant = createFleetRuntime({
			env: { HOBO_FLEET_HOME: home, HOBO_FLEET_AUTHORITY_URL: "https://f" },
			progress: quiet,
			log: quiet,
		});
		const second = await noTenant.local.startAgent({ fleets: [] });
		expect(!second.ok && second.error.message).toContain("no tenant");
		const badStore = createFleetRuntime({
			env: { HOBO_FLEET_HOME: home, HOBO_FLEET_KEYSTORE: "tpm" },
			progress: quiet,
			log: quiet,
		});
		expect((await badStore.local.startAgent({ fleets: [] })).ok).toBe(false);
		expect((await badStore.local.generateKeys()).ok).toBe(false);
		expect((await badStore.local.loadKeyStore()).ok).toBe(false);
		expect((await badStore.io.deviceMemberId()).ok).toBe(false);
		expect((await badStore.io.rotationRequest()).ok).toBe(false);
		expect((await badStore.client({ kind: "device" })).ok).toBe(false);
	});

	it("refreshes credentials before a device call and leaves with the SVID", async () => {
		const home = await temporary();
		const requests: string[] = [];
		const runtime = createFleetRuntime({
			env: {
				HOBO_FLEET_HOME: home,
				HOBO_FLEET_AUTHORITY_URL: "https://fleet.test",
			},
			progress: quiet,
			fetch: authority(requests),
			log: quiet,
		});
		const member = await runtime.io.deviceMemberId();
		const client = await runtime.client({ kind: "device" });
		expect(client.ok).toBe(true);
		if (!client.ok || !member.ok) return;
		const left = await client.value.leave({ memberId: member.value });
		expect(left.ok).toBe(true);
		expect(requests).toEqual([
			`POST /v1/fleet/members/${encodeURIComponent(member.value)}/credentials`,
			`POST /v1/fleet/members/${encodeURIComponent(member.value)}/leave`,
		]);
	});

	it("rotates the operational keys into the next bundle sequence", async () => {
		const home = await temporary();
		const requests: string[] = [];
		const runtime = createFleetRuntime({
			env: {
				HOBO_FLEET_HOME: home,
				HOBO_FLEET_AUTHORITY_URL: "https://fleet.test",
			},
			progress: quiet,
			fetch: authority(requests),
			log: quiet,
		});
		const rotation = await runtime.io.rotationRequest();
		expect(rotation.ok).toBe(true);
		if (!rotation.ok) return;
		const bundle = fromBinary(
			KeyBundleSchema,
			rotation.value.request.keyBundle?.payload ?? new Uint8Array(),
		);
		expect(bundle.sequence).toBe(4);
		expect(Date.parse(bundle.notAfter) - Date.parse(bundle.issuedAt)).toBe(
			7_200_000,
		);
	});

	it("refuses a session with no transport it can dial from", async () => {
		const runtime = createFleetRuntime({
			env: {
				HOBO_FLEET_HOME: await temporary(),
				HOBO_FLEET_TRANSPORTS: "bus-relay",
			},
			progress: quiet,
			log: quiet,
		});
		const initiator = await runtime.io.prepareInitiator();
		expect(!initiator.ok && initiator.error.message).toContain(
			"no transport this CLI can dial from",
		);
	});

	it("skips overlay joins of providers it cannot drive", async () => {
		const home = await temporary();
		const runtime = createFleetRuntime({
			env: { HOBO_FLEET_HOME: home },
			progress: quiet,
			log: quiet,
		});
		const saved = await runtime.io.saveEnrollment(
			create(EnrollmentResponseSchema, {
				memberRecord: memberEnvelope("m_1", 1),
				discovery: create(DiscoverySchema, { tenant: "acme" }),
				overlayJoins: [{ provider: "wireguard", credential: "x", tags: [] }],
			}),
		);
		expect(saved.ok && saved.value).toBe(
			"Run hobo fleet run to start serving.",
		);
		const text = await readFile(join(home, "enrollment.json"), "utf8");
		expect(text).not.toContain('"x"');
	});

	it("verifies the audit chain with a journal of trust rotations", async () => {
		const home = await temporary();
		const runtime = createFleetRuntime({
			env: { HOBO_FLEET_HOME: home },
			progress: quiet,
			log: quiet,
		});
		const trustFile = join(home, "trust.json");
		await writeFile(
			trustFile,
			toJsonString(
				WitnessedEnvelopeSchema,
				create(WitnessedEnvelopeSchema, {
					authority: create(SignedEnvelopeSchema, {
						payload: toBinary(
							TrustRecordSchema,
							create(TrustRecordSchema, { tenant: "acme", sequence: 1 }),
						),
					}),
				}),
			),
		);
		const journalFile = join(home, "journal.json");
		await writeFile(journalFile, "[]");
		const verified = await runtime.local.verifyAuditChain([], [], {
			trustFile,
			journalFile,
		});
		expect(verified).toEqual({
			ok: true,
			value: { entries: 0, finalThrough: 0 },
		});
		// An enrolled device with no pinned trust record still needs --trust.
		await runtime.local.generateKeys();
		const unpinned = await runtime.local.verifyAuditChain([], [], {});
		expect(unpinned.ok).toBe(false);
	});

	it("reports the p2p self-start either way", async () => {
		const runtime = createFleetRuntime({
			env: { HOBO_FLEET_HOME: await temporary() },
			progress: quiet,
			log: quiet,
		});
		const dial = await runtime.local.transportSelfDial();
		expect(dial.ok ? dial.value : dial.error.message).toMatch(/p2p/);
	});
});
