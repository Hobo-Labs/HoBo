import { createHash } from "node:crypto";
import type { TenantId } from "@hobo/core";
import { MemberKind } from "../_generated/fleet_pb.js";
import { FleetParseError } from "../errors.js";
import {
	type FleetId,
	type MemberId,
	type MemberName,
	parseMemberId,
} from "../ids.js";

const ID_HEX = 32;

function hex32(text: string): string {
	return createHash("sha256")
		.update(text, "utf8")
		.digest("hex")
		.slice(0, ID_HEX);
}

export function deviceMemberId(thumbprint: string): MemberId {
	return parseMemberId(`dev_${hex32(thumbprint)}`);
}

export function sponsoredId(
	tenant: TenantId,
	kind: MemberKind,
	fleet: FleetId,
	name: MemberName,
): MemberId {
	const prefix =
		kind === MemberKind.BACKEND
			? "bkd"
			: kind === MemberKind.TARGET
				? "tgt"
				: undefined;
	const kindName =
		kind === MemberKind.BACKEND
			? "BACKEND"
			: kind === MemberKind.TARGET
				? "TARGET"
				: undefined;
	if (prefix === undefined || kindName === undefined)
		throw new FleetParseError(
			"kind",
			"only BACKEND and TARGET members are sponsored",
		);
	return parseMemberId(
		`${prefix}_${hex32([tenant, kindName, fleet, name].join("\u0000"))}`,
	);
}
