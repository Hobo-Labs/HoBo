import { fromBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { TrustRecordSchema } from "../../../src/_generated/fleet_pb.js";
import { TRUST_RECORD_CONTEXT } from "../../../src/contexts.js";
import { FleetNotImplemented } from "../../../src/errors.js";
import { createTestAuthority } from "../../../src/testing/plumbing/test-authority.js";

describe("createTestAuthority", () => {
	// Composition only: until the parts it composes have merged (end of wave 3)
	// it rejects with FleetNotImplemented; afterwards it publishes its trust record.
	it("publishes a sequence-1 trust record on its bus, or reports the missing part", async () => {
		const now = () => Date.parse("2026-11-12T10:00:00Z");
		let composed: Awaited<ReturnType<typeof createTestAuthority>> | undefined;
		try {
			composed = await createTestAuthority(now);
		} catch (error) {
			expect(error).toBeInstanceOf(FleetNotImplemented);
			return;
		}
		const authority = composed.trust.authority;
		expect(authority?.context).toBe(TRUST_RECORD_CONTEXT);
		const record = fromBinary(
			TrustRecordSchema,
			authority?.payload ?? new Uint8Array(),
		);
		expect(record.sequence).toBe(1);
		expect(record.tenant).toBe("test");
		expect(record.authorityKeys[0]?.keyId).toBe("authority#1");
		expect(record.witnessKeys[0]?.keyId).toBe("witness#1");
		expect(composed.bus.registry.trust().sequence).toBe(1);
	});
});
