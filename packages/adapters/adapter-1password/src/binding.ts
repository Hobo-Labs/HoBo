/**
 * Parse, don't validate: a `OnePasswordBinding` record becomes a
 * `ParsedOnePasswordBinding` here, once, or is refused by field name.
 */

import { create } from "@bufbuild/protobuf";
import {
	type OnePasswordBinding,
	OnePasswordBindingSchema,
} from "./_generated/adapter_1password_pb.js";
import { OnePasswordError } from "./errors.js";

declare const parsedBinding: unique symbol;

export type ParsedOnePasswordBinding = Readonly<{
	vaultId: string;
	authMode: "service-account" | "desktop-app";
	accountName: string | undefined;
	readonly [parsedBinding]: true;
}>;

const ID = /^[a-z0-9]{26}$/u;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

export function parseOnePasswordBinding(
	record: OnePasswordBinding,
): ParsedOnePasswordBinding {
	const authMode = (["service-account", "desktop-app"] as const).find(
		(mode) => mode === record.authMode,
	);
	if (
		!ID.test(record.vaultId) ||
		authMode === undefined ||
		record.accountName.length > 100 ||
		record.accountName.includes("\n") ||
		(authMode === "desktop-app" && record.accountName === "")
	)
		throw new OnePasswordError("parse binding", "invalid-input");
	// SAFETY: every field above was checked; the brand records that.
	return Object.freeze({
		vaultId: record.vaultId,
		authMode,
		accountName: record.accountName === "" ? undefined : record.accountName,
	}) as ParsedOnePasswordBinding;
}

export function onePasswordBinding(
	init: Partial<Omit<OnePasswordBinding, "$typeName" | "$unknown">>,
): ParsedOnePasswordBinding {
	return parseOnePasswordBinding(create(OnePasswordBindingSchema, init));
}

/** A secret name, as the item's title. */
export function parseOnePasswordSecretName(name: string): string {
	if (!SECRET_NAME.test(name))
		throw new OnePasswordError("secret name", "invalid-input");
	return name;
}
