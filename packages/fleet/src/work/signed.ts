import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	type KeyBundle,
	KeyBundleSchema,
	KeyPurpose,
	type MemberRecord,
	type PublicKeyRef,
	type SignedEnvelope,
	type TrustRecord,
	type WorkLogChunk,
	WorkLogChunkSchema,
	type WorkReceipt,
	WorkReceiptSchema,
} from "../_generated/fleet_pb.js";
import {
	KEY_BUNDLE_CONTEXT,
	LOG_CONTEXT,
	RECEIPT_CONTEXT,
	WORK_SUBMISSION_CONTEXT,
} from "../contexts.js";
import { type MemberId, parseMemberId } from "../ids.js";
import { parsePublicJwk, signEnvelope, verifyEnvelope } from "../keys/index.js";
import type { FleetContext, RegistryView, Signer } from "../ports.js";

export function signerOf(keyId: string): MemberId | undefined {
	const [member, purpose] = keyId.split("#");
	if (purpose !== "sign" || member === undefined) return undefined;
	try {
		return parseMemberId(member);
	} catch {
		return undefined;
	}
}

export function bundleOf(record: MemberRecord): KeyBundle | undefined {
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

export function keyOf(
	record: MemberRecord,
	purpose: KeyPurpose,
): PublicKeyRef | undefined {
	return bundleOf(record)?.keys.find((key) => key.purpose === purpose);
}

export async function deviceSigner(
	registry: RegistryView,
	envelope: SignedEnvelope,
	context: FleetContext,
): Promise<MemberRecord | undefined> {
	if (envelope.context !== context) return undefined;
	const id = signerOf(envelope.keyId);
	if (id === undefined) return undefined;
	const record = await registry.member(id);
	if (record === undefined) return undefined;
	const key = keyOf(record, KeyPurpose.SIGN);
	if (key === undefined || key.keyId !== envelope.keyId) return undefined;
	return verifyEnvelope(envelope, context, key) ? record : undefined;
}

export function authoritySigned(
	envelope: SignedEnvelope,
	trust: TrustRecord,
): boolean {
	if (envelope.context !== WORK_SUBMISSION_CONTEXT) return false;
	const key = trust.authorityKeys.find(
		(candidate) => candidate.keyId === envelope.keyId,
	);
	return (
		key !== undefined && verifyEnvelope(envelope, WORK_SUBMISSION_CONTEXT, key)
	);
}

export function signReceipt(
	signer: Signer,
	receipt: WorkReceipt,
): Promise<SignedEnvelope> {
	return signEnvelope(
		signer,
		RECEIPT_CONTEXT,
		toBinary(WorkReceiptSchema, receipt),
	);
}

export function signLogChunk(
	signer: Signer,
	chunk: Pick<WorkLogChunk, "orderId" | "sequence" | "data" | "last">,
): Promise<SignedEnvelope> {
	const message = create(WorkLogChunkSchema, chunk);
	return signEnvelope(
		signer,
		LOG_CONTEXT,
		toBinary(WorkLogChunkSchema, message),
	);
}
