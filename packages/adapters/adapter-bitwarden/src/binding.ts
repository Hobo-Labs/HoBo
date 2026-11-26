/**
 * Parse, don't validate: a `BitwardenBinding` record becomes a
 * `ParsedBitwardenBinding` here, once, or is refused.
 */

import { create } from "@bufbuild/protobuf";
import {
	type BitwardenBinding,
	BitwardenBindingSchema,
} from "./_generated/adapter_bitwarden_pb.js";
import { BitwardenError } from "./errors.js";

declare const parsedBinding: unique symbol;

export type ParsedBitwardenBinding = Readonly<{
	organizationId: string;
	projectId: string;
	apiUrl: string;
	readonly [parsedBinding]: true;
}>;

// public-contract: Bitwarden's US cloud API, the SDK's default.
export const BITWARDEN_US_API = "https://api.bitwarden.com";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/u;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

export function parseBitwardenBinding(
	record: BitwardenBinding,
): ParsedBitwardenBinding {
	const apiUrl = record.apiUrl === "" ? BITWARDEN_US_API : record.apiUrl;
	if (
		!UUID.test(record.organizationId) ||
		!UUID.test(record.projectId) ||
		!ORIGIN.test(apiUrl)
	)
		throw new BitwardenError("parse binding", "invalid-input");
	// SAFETY: every field above was checked; the brand records that.
	return Object.freeze({
		organizationId: record.organizationId,
		projectId: record.projectId,
		apiUrl,
	}) as ParsedBitwardenBinding;
}

export function bitwardenBinding(
	init: Partial<Omit<BitwardenBinding, "$typeName" | "$unknown">>,
): ParsedBitwardenBinding {
	return parseBitwardenBinding(create(BitwardenBindingSchema, init));
}

export function parseBitwardenSecretName(name: string): string {
	if (!SECRET_NAME.test(name))
		throw new BitwardenError("secret name", "invalid-input");
	return name;
}
