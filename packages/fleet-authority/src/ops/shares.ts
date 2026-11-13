// Two-of-two shares of the operator key (design §6.16 "Key ceremony"): the
// first share is 32 random bytes, the second the seed XOR the first, so each
// share alone is uniformly random and says nothing about the key. Each share
// names its index and the operator's public key, so a wrong pairing is
// detected when they are combined. Private to L27.
import { randomBytes } from "node:crypto";
import type { Outcome } from "@hobo/fleet";
import { encodeNkeyPublic, encodeNkeySeed } from "./nkeys.js";

// public-contract: the text form of a ceremony share, `hobo-fleet-share:<1|2>:<operator public key>:<32 bytes base64url>`.
const SHARE_PREFIX = "hobo-fleet-share";

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length);
	for (let i = 0; i < a.length; i += 1) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
	return out;
}

function shareText(index: 1 | 2, operator: string, bytes: Uint8Array): string {
	return `${SHARE_PREFIX}:${index}:${operator}:${Buffer.from(bytes).toString("base64url")}`;
}

export function splitOperatorSeed(seed: Uint8Array): readonly [string, string] {
	const operator = encodeNkeyPublic("operator", seed);
	const first = new Uint8Array(randomBytes(seed.length));
	return [
		shareText(1, operator, first),
		shareText(2, operator, xor(seed, first)),
	];
}

type Share = Readonly<{ index: 1 | 2; operator: string; bytes: Uint8Array }>;

function parseShare(text: string): Share | undefined {
	const parts = text.trim().split(":");
	if (parts.length !== 4 || parts[0] !== SHARE_PREFIX) return undefined;
	const index = parts[1] === "1" ? 1 : parts[1] === "2" ? 2 : undefined;
	const operator = parts[2] ?? "";
	const bytes = new Uint8Array(Buffer.from(parts[3] ?? "", "base64url"));
	if (index === undefined || bytes.length !== 32 || !operator.startsWith("O"))
		return undefined;
	return { index, operator, bytes };
}

/** The operator key's nkey seed from its two shares, in either order. */
export function combineShares(
	a: string,
	b: string,
): Outcome<Readonly<{ operatorPublicKey: string; operatorSeed: string }>> {
	const first = parseShare(a);
	const second = parseShare(b);
	if (
		first === undefined ||
		second === undefined ||
		first.index === second.index ||
		first.operator !== second.operator
	)
		return {
			ok: false,
			error: {
				code: "invalid-request",
				message: "two different shares of one operator key are needed",
			},
		};
	const seed = xor(first.bytes, second.bytes);
	const operatorPublicKey = encodeNkeyPublic("operator", seed);
	if (operatorPublicKey !== first.operator)
		return {
			ok: false,
			error: {
				code: "invalid-request",
				message: "the shares do not reconstruct the operator key they name",
			},
		};
	return {
		ok: true,
		value: {
			operatorPublicKey,
			operatorSeed: encodeNkeySeed("operator", seed),
		},
	};
}
