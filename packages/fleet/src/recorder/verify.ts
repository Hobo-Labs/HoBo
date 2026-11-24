import { fromBinary, type Message } from "@bufbuild/protobuf";
import type { GenMessage } from "@bufbuild/protobuf/codegenv2";
import {
	type KeyBundle,
	KeyBundleSchema,
	KeyPurpose,
	type MemberRecord,
	Role,
	type SignedEnvelope,
} from "../_generated/fleet_pb.js";
import { KEY_BUNDLE_CONTEXT } from "../contexts.js";
import { type MemberId, parseMemberId } from "../ids.js";
import { parsePublicJwk, verifyEnvelope } from "../keys/index.js";
import type { FleetContext, RegistryView } from "../ports.js";

/** domain-view: why an envelope was not recorded; logged with the count. */
export type Unverifiable =
	| "context"
	| "key-id"
	| "signer-unknown"
	| "bundle-invalid"
	| "key-unknown"
	| "signature"
	| "payload"
	| "signer-mismatch"
	| "not-dispatcher";

export type Checked<T> = Readonly<
	| { ok: true; value: T; signer: MemberRecord }
	| { ok: false; reason: Unverifiable }
>;

function signerOf(keyId: string): MemberId | undefined {
	const [id, purpose, ...rest] = keyId.split("#");
	if (purpose !== "sign" || rest.length > 0 || id === undefined)
		return undefined;
	try {
		return parseMemberId(id);
	} catch {
		return undefined;
	}
}

function bundleOf(record: MemberRecord): KeyBundle | undefined {
	const envelope = record.keyBundle;
	if (envelope === undefined) return undefined;
	const identity = parsePublicJwk(record.identityJwk);
	if (
		!identity.ok ||
		!verifyEnvelope(envelope, KEY_BUNDLE_CONTEXT, identity.value)
	)
		return undefined;
	try {
		const bundle = fromBinary(KeyBundleSchema, envelope.payload);
		return bundle.memberId === record.memberId ? bundle : undefined;
	} catch {
		return undefined;
	}
}

export async function verifySigned<T extends Message>(
	registry: RegistryView,
	envelope: SignedEnvelope,
	context: FleetContext,
	schema: GenMessage<T>,
): Promise<Checked<T>> {
	if (envelope.context !== context) return { ok: false, reason: "context" };
	const signerId = signerOf(envelope.keyId);
	if (signerId === undefined) return { ok: false, reason: "key-id" };
	const signer = await registry.member(signerId);
	if (signer === undefined) return { ok: false, reason: "signer-unknown" };
	const bundle = bundleOf(signer);
	if (bundle === undefined) return { ok: false, reason: "bundle-invalid" };
	const key = bundle.keys.find(
		(candidate) =>
			candidate.purpose === KeyPurpose.SIGN &&
			candidate.keyId === envelope.keyId,
	);
	if (key === undefined) return { ok: false, reason: "key-unknown" };
	if (!verifyEnvelope(envelope, context, key))
		return { ok: false, reason: "signature" };
	try {
		return { ok: true, value: fromBinary(schema, envelope.payload), signer };
	} catch {
		return { ok: false, reason: "payload" };
	}
}

export function dispatches(record: MemberRecord, fleet: string): boolean {
	return record.memberships.some(
		(membership) =>
			membership.fleet === fleet && membership.roles.includes(Role.DISPATCHER),
	);
}
