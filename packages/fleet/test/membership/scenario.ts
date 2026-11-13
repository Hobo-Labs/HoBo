// Scenario helpers over the harness: invite, enroll, activate, refresh.
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	DeviceClass,
	type MemberRecord,
	MemberRecordSchema,
	Role,
	type SignedEnvelope,
	TokenCreateRequestSchema,
} from "../../src/_generated/fleet_pb.js";
import type {
	EnrollmentAuthority,
	Outcome,
	VerifiedToken,
} from "../../src/ports.js";
import {
	device,
	enrollment,
	type Harness,
	type TestDevice,
	why,
} from "./fixtures.js";

export function value<T>(outcome: Outcome<T>): T {
	if (!outcome.ok)
		throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
	return outcome.value;
}

export function code<T>(outcome: Outcome<T>): string {
	return outcome.ok ? "ok" : outcome.error.code;
}

export function decoded(envelope: SignedEnvelope | undefined): MemberRecord {
	if (envelope === undefined) throw new Error("no record");
	return fromBinary(MemberRecordSchema, envelope.payload);
}

export async function token(
	h: Harness,
	caller: VerifiedToken,
	fleet = "build",
	name = "laptop",
	roles: readonly Role[] = [Role.EXECUTOR],
): Promise<string> {
	return value(
		await h.authority.issueToken(
			create(TokenCreateRequestSchema, {
				fleet,
				name,
				deviceClass: DeviceClass.PERSONAL,
				roles: [...roles],
				ttlSeconds: 900,
			}),
			caller,
		),
	).token;
}

/** A PENDING device in `fleet` invited by `caller`. */
export async function pending(
	h: Harness,
	caller: VerifiedToken,
	fleet = "build",
	name = "laptop",
	roles: readonly Role[] = [Role.EXECUTOR],
): Promise<TestDevice> {
	const subject = await device(h.clock.now());
	value(
		await h.authority.enroll(
			enrollment(subject, {
				fleet,
				name,
				requestedRoles: [...roles],
				proof: {
					case: "bootstrapToken",
					value: await token(h, caller, fleet, name, roles),
				},
			}),
			undefined,
		),
	);
	return subject;
}

/** An ACTIVE device: invited, approved and accepted by `caller`. */
export async function active(
	h: Harness,
	caller: VerifiedToken,
	fleet = "build",
	name = "laptop",
	roles: readonly Role[] = [Role.EXECUTOR],
): Promise<TestDevice> {
	const subject = await pending(h, caller, fleet, name, roles);
	const memberId = subject.keys.memberId;
	value(await h.authority.approveKey({ memberId, request: why() }, caller));
	value(await h.authority.accept({ memberId, request: why() }, caller));
	return subject;
}

export async function stateOf(
	h: Harness,
	subject: TestDevice,
	caller: VerifiedToken,
): Promise<MemberRecord> {
	return decoded(
		value(
			await h.authority.getMember(
				ids<"getMember">({ memberId: subject.keys.memberId }),
				caller,
			),
		),
	);
}

/** The by-id routes whose request is only ids. */
type IdOnly = "getMember" | "leave" | "revokeToken" | "workStatus" | "workLogs";

/**
 * A by-id request. `ById<K>`'s default `Empty` (`Record<string, never>`) makes
 * every field `never`, so no object literal satisfies it; the contract defect
 * is reported in the lane's requirementChanges, and tests build the request here.
 */
export function ids<M extends IdOnly>(
	fields: Readonly<Record<string, string>>,
): Parameters<EnrollmentAuthority[M]>[0] {
	// SAFETY: these methods read only the named id fields, which `fields` carries.
	return fields as Parameters<EnrollmentAuthority[M]>[0];
}
