/**
 * Branded ids and their parse-don't-validate constructors (design §7.2, §7.3).
 *
 * A value of one of these types has passed its constructor; nothing else may
 * produce one. Each constructor throws `FleetParseError` (code
 * `invalid-request`) and names the field it was checking.
 */
import { FleetParseError } from "./errors.js";

export type MemberId = string & { readonly __brand: "MemberId" };
export type FleetId = string & { readonly __brand: "FleetId" };
/** A member's name inside one fleet (names are per fleet). Same shape as a FleetId. */
export type MemberName = string & { readonly __brand: "MemberName" };
export type WorkDigest = string & { readonly __brand: "WorkDigest" };
export type KeyId = string & { readonly __brand: "KeyId" };

const MEMBER_ID = /^(dev|bkd|tgt)_[0-9a-f]{32}$/u;
const SHORT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const WORK_DIGEST = /^[0-9a-f]{32}$/u;
const KEY_ID =
	/^((dev|bkd|tgt)_[0-9a-f]{32}#(identity|sign|seal|transport)|authority#[0-9]+|witness#[0-9]+)$/u;

/** `dev_`, `bkd_` or `tgt_` and 32 lower-case hex digits. */
export function parseMemberId(value: string, field = "member_id"): MemberId {
	if (!MEMBER_ID.test(value))
		throw new FleetParseError(
			field,
			`${field} must be dev_, bkd_ or tgt_ followed by 32 lower-case hex digits`,
		);
	// SAFETY: the pattern of §7.2 was checked on the line above.
	return value as MemberId;
}

/** A short lower-case token: a letter or digit, then up to 62 of `[a-z0-9_-]`. */
export function parseFleetId(value: string, field = "fleet"): FleetId {
	if (!SHORT_NAME.test(value))
		throw new FleetParseError(
			field,
			`${field} must be a short lower-case token`,
		);
	// SAFETY: the pattern of §7.2 was checked on the line above.
	return value as FleetId;
}

/** A member's name in a fleet; the same pattern as a fleet id. Replaces `parseFleetBackendId`. */
export function parseMemberName(value: string, field = "name"): MemberName {
	if (!SHORT_NAME.test(value))
		throw new FleetParseError(
			field,
			`${field} must be a short lower-case token`,
		);
	// SAFETY: the pattern of §7.2 was checked on the line above.
	return value as MemberName;
}

/** 32 lower-case hex digits. */
export function parseWorkDigest(
	value: string,
	field = "work_digest",
): WorkDigest {
	if (!WORK_DIGEST.test(value))
		throw new FleetParseError(
			field,
			`${field} must be 32 lower-case hex digits`,
		);
	// SAFETY: the pattern of §7.2 was checked on the line above.
	return value as WorkDigest;
}

/** `<MemberId>#identity|sign|seal|transport`, `authority#<n>` or `witness#<n>`. */
export function parseKeyId(value: string, field = "key_id"): KeyId {
	if (!KEY_ID.test(value))
		throw new FleetParseError(
			field,
			`${field} must be <member id>#<purpose>, authority#<n> or witness#<n>`,
		);
	// SAFETY: the pattern of §7.2 was checked on the line above.
	return value as KeyId;
}

/** The one list of overlay providers (design §8.3); `runtime-celld` validates against it. */
export const OVERLAY_PROVIDERS = [
	// public-contract: overlay provider names accepted in configuration and OverlayJoin.provider.
	"tailscale",
	"netbird",
	"wireguard",
] as const;

export type OverlayProvider = (typeof OVERLAY_PROVIDERS)[number];
