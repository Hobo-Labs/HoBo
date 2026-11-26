/**
 * The Yard record `ecs.cluster.ready` registers, and what it takes from the
 * provider payload.
 *
 * `yard-event-fold.test.ts` next door covers the fold's *contract* — which
 * event types come out, in what order, and that `occurredAt` is honoured. It
 * says so explicitly, and deliberately leaves the payload alone. This is the
 * other half: the `yard.Registered` event carries a whole `hobo.yard-instance/v1`
 * record built by reading an arbitrary control-plane payload, and that
 * construction has its own failure modes.
 *
 * **The record is durable.** It goes into the event store, so a field derived
 * wrongly here is not a display bug — it is written history that later folds
 * read back as fact.
 *
 * **Which makes what it *omits* as important as what it keeps.** The payload is
 * whatever AWS's control plane happened to include, and a record built by
 * copying it wholesale would put session tokens and signed URLs into that
 * durable history. The record names refs and nothing else, so the tests assert
 * on absence too.
 *
 * **Defaults exist so a yard stays addressable.** A yard registered with no
 * region cannot be placed into; a ref property set to the string "undefined"
 * looks like a real ref to everything downstream. Both fallbacks are pinned.
 */
import { describe, expect, it } from "vitest";

import { isJsonObject, type JsonObject } from "../src/json.js";
import { normalizeAwsYardSignal } from "../src/yard-event-fold.js";

const AT = "2026-01-01T00:00:00.000Z";

/** The yard record out of a `ready` signal carrying `payload`. */
function registeredYard(payload: JsonObject = {}): JsonObject {
	const [registered] = normalizeAwsYardSignal({
		providerId: "aws" as const,
		kind: "ecs.cluster.ready",
		payload,
		observedAt: AT,
	});
	const yard = registered?.data.yard;
	if (!isJsonObject(yard)) throw new Error("expected a yard instance");
	return yard;
}

function layout(payload: JsonObject = {}): JsonObject {
	const value = registeredYard(payload).layout;
	if (!isJsonObject(value)) throw new Error("expected a layout");
	return value;
}

describe("identifying the yard", () => {
	it("prefers an explicit yard id", () => {
		expect(
			registeredYard({ yardId: "yard-1", clusterArn: "arn:x" }).yardId,
		).toBe("yard-1");
	});

	it("falls back to the cluster arn", () => {
		// The arn is the only stable identifier AWS gives for a cluster, so it is
		// what keeps the yard addressable when the signal names no yard.
		expect(registeredYard({ clusterArn: "arn:aws:ecs:x" }).yardId).toBe(
			"arn:aws:ecs:x",
		);
	});

	it("falls back to a provider-scoped placeholder rather than an empty id", () => {
		// Unlike the identifier fields on the other events, this one defaults to
		// "yard:aws" rather than "". An empty yardId would register a record that
		// no later event could ever address.
		expect(registeredYard().yardId).toBe("yard:aws");
	});

	it("defaults the owning tenant to local", () => {
		expect(registeredYard().ownerTenantId).toBe("local");
		expect(registeredYard({ ownerTenantId: "tenant-9" }).ownerTenantId).toBe(
			"tenant-9",
		);
	});

	it("defaults the runtime to this provider's versioned runtime id", () => {
		expect(registeredYard().runtimeId).toBe("aws.yard-runtime/v1");
	});
});

describe("the layout it registers", () => {
	it("defaults to a region rather than registering a yard with none", () => {
		// A yard with no region cannot be placed into. The default keeps it
		// usable until a real region is observed.
		expect(layout().regions).toEqual(["us-east-1"]);
	});

	it("takes the regions the payload lists", () => {
		expect(layout({ regions: ["eu-west-1", "us-west-2"] }).regions).toEqual([
			"eu-west-1",
			"us-west-2",
		]);
	});

	it("ignores a regions field that is not a list", () => {
		// `isJsonArray` guards it, so a scalar or object falls back to the
		// default instead of producing a regions list of characters.
		expect(layout({ regions: "eu-west-1" }).regions).toEqual(["us-east-1"]);
		expect(layout({ regions: { primary: "eu-west-1" } }).regions).toEqual([
			"us-east-1",
		]);
	});

	it("stringifies region entries rather than passing them through", () => {
		expect(layout({ regions: [1, true] }).regions).toEqual(["1", "true"]);
	});

	it("requires a managed container substrate on a private network", () => {
		// These are what the yard is claiming it can host; a placement engine
		// matches against them, so they are contract rather than description.
		expect(layout().require).toEqual([
			"managed-container-substrate",
			"private-network",
		]);
		expect(layout().network).toEqual(["private"]);
	});
});

describe("the refs it carries, and the ones it does not", () => {
	it("omits ref properties entirely when the payload names none", () => {
		// Spread-if-present, not a key set to "undefined". A property whose value
		// is the string "undefined" reads as a real ref to anything consuming it.
		expect(layout().properties).toEqual({});
	});

	it("carries the account and vpc refs when present", () => {
		expect(layout({ accountRef: "acct-1", vpcId: "vpc-1" }).properties).toEqual(
			{
				"aws.accountRef": "acct-1",
				"aws.vpcId": "vpc-1",
			},
		);
	});

	it("carries each ref independently of the other", () => {
		expect(layout({ vpcId: "vpc-1" }).properties).toEqual({
			"aws.vpcId": "vpc-1",
		});
		expect(layout({ accountRef: "acct-1" }).properties).toEqual({
			"aws.accountRef": "acct-1",
		});
	});

	it("does not copy unrecognised payload fields into the record", () => {
		// The record is built from an arbitrary control-plane payload and written
		// to the event store. Copying it wholesale would put whatever AWS
		// included -- session tokens, signed URLs -- into durable history.
		const yard = registeredYard({
			yardId: "y",
			secretAccessKey: "AKIA-SECRET-VALUE",
			sessionToken: "session-token-value",
			presignedUrl: "https://s3/presigned?X-Amz-Signature=deadbeef",
		});
		const serialized = JSON.stringify(yard);
		expect(serialized).not.toContain("AKIA-SECRET-VALUE");
		expect(serialized).not.toContain("session-token-value");
		expect(serialized).not.toContain("X-Amz-Signature");
	});
});

describe("the state a freshly registered yard is in", () => {
	it("registers as registering, not ready", () => {
		// Readiness is a separate event in the same fan-out. A record that
		// registered itself ready would let a placement land before the
		// attestation events that follow it.
		expect(registeredYard().status).toBe("registering");
	});

	it("starts at generation 1 with a registered signal", () => {
		const health = registeredYard().health;
		if (!isJsonObject(health)) throw new Error("expected health");
		expect(health.generation).toBe(1);
		expect(health.signals).toEqual(["registered"]);
	});

	it("starts with capacity and no reservations", () => {
		const capacity = registeredYard().capacity;
		if (!isJsonObject(capacity)) throw new Error("expected capacity");
		expect(capacity.reservations).toEqual({});
		expect(capacity.classes).toEqual({ default: 100 });
	});

	it("advertises the capabilities its layout requires", () => {
		// The requires/provides pair has to be consistent, or the yard advertises
		// a substrate it did not claim it could host.
		const capabilities = registeredYard().capabilities;
		expect(capabilities).toContain("managed-container-substrate");
		expect(capabilities).toContain("private-network");
		expect(capabilities).toContain("managed-http-runtime");
	});
});
