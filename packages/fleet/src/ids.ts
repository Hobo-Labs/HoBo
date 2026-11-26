import { FleetParseError } from "./errors.js";

export type MemberId = string & { readonly __brand: "MemberId" };
export type FleetId = string & { readonly __brand: "FleetId" };
export type MemberName = string & { readonly __brand: "MemberName" };
export type WorkDigest = string & { readonly __brand: "WorkDigest" };
export type KeyId = string & { readonly __brand: "KeyId" };

const MEMBER_ID = /^(dev|bkd|tgt)_[0-9a-f]{32}$/u;
const SHORT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const WORK_DIGEST = /^[0-9a-f]{32}$/u;
const KEY_ID =
	/^((dev|bkd|tgt)_[0-9a-f]{32}#(identity|sign|seal|transport)|authority#[0-9]+|witness#[0-9]+)$/u;

function isMemberId(value: string): value is MemberId {
	return MEMBER_ID.test(value);
}

function isFleetId(value: string): value is FleetId {
	return SHORT_NAME.test(value);
}

function isMemberName(value: string): value is MemberName {
	return SHORT_NAME.test(value);
}

function isWorkDigest(value: string): value is WorkDigest {
	return WORK_DIGEST.test(value);
}

function isKeyId(value: string): value is KeyId {
	return KEY_ID.test(value);
}

export function parseMemberId(value: string, field = "member_id"): MemberId {
	if (!isMemberId(value))
		throw new FleetParseError(
			field,
			`${field} must be dev_, bkd_ or tgt_ followed by 32 lower-case hex digits`,
		);
	return value;
}

export function parseFleetId(value: string, field = "fleet"): FleetId {
	if (!isFleetId(value))
		throw new FleetParseError(
			field,
			`${field} must be a short lower-case token`,
		);
	return value;
}

export function parseMemberName(value: string, field = "name"): MemberName {
	if (!isMemberName(value))
		throw new FleetParseError(
			field,
			`${field} must be a short lower-case token`,
		);
	return value;
}

export function parseWorkDigest(
	value: string,
	field = "work_digest",
): WorkDigest {
	if (!isWorkDigest(value))
		throw new FleetParseError(
			field,
			`${field} must be 32 lower-case hex digits`,
		);
	return value;
}

export function parseKeyId(value: string, field = "key_id"): KeyId {
	if (!isKeyId(value))
		throw new FleetParseError(
			field,
			`${field} must be <member id>#<purpose>, authority#<n> or witness#<n>`,
		);
	return value;
}

export const OVERLAY_PROVIDERS = [
	// public-contract: overlay provider names accepted in configuration and OverlayJoin.provider.
	"tailscale",
	"netbird",
	"wireguard",
] as const;

export type OverlayProvider = (typeof OVERLAY_PROVIDERS)[number];
