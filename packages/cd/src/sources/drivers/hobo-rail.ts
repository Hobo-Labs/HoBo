// HOBO_RAIL subscriptions (D24): Rail approvals become Freight with subject
// RAIL. The driver reads the frozen RailEventReader forward from its cursor
// and yields one discovered artifact per approved Rail digest (the digest is
// both the version and the declaration). Retired digests seen in the same
// read are never discovered, and a digest approved twice is discovered once.
import { create } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	ArtifactRefSchema,
	SubscriptionKind,
} from "../../_generated/cd_pb.js";
import type { RailEventReader, SubscriptionDriver } from "../../ports.js";
import { isDigest } from "../json.js";
import { refuse, SOURCE_REASON } from "../reasons.js";
import {
	type Candidate,
	discovered,
	discoveryLimit,
	parseCursor,
	writeCursor,
} from "./common.js";

/** Upper bound of Rail events scanned per poll; the cursor resumes after it. */
export const RAIL_SCAN_LIMIT = 10_000;

export function railCoordinate(railId: string, railDigest: string): string {
	return `rail:${railId}@${railDigest}`;
}

export function createRailDriver(
	d: Readonly<{ readRailEvents?: RailEventReader }>,
): SubscriptionDriver {
	return {
		kind: SubscriptionKind.HOBO_RAIL,
		async discover(input, ctx) {
			const read = d.readRailEvents;
			if (!read) {
				return refuse(
					SOURCE_REASON.driverUnavailable,
					"HOBO_RAIL discovery has no RailEventReader",
					"compose createSubscriptionDrivers with readRailEvents (the Station Rail journal reader)",
					input.subscription.name,
				);
			}
			const railId = input.subscription.locator;
			const previous = parseCursor(input.cursor);
			const approved = new Map<string, string>();
			const retired = new Set<string>();
			let at = previous.at;
			let scanned = 0;
			for await (const event of read(previous.at, input.signal)) {
				scanned += 1;
				at = event.cursor;
				if (event.railId === railId && isDigest(event.railDigest)) {
					if (event.status === "retired") retired.add(event.railDigest);
					else if (!approved.has(event.railDigest))
						approved.set(event.railDigest, event.cursor);
				}
				if (scanned >= RAIL_SCAN_LIMIT) break;
			}
			const candidates: Candidate[] = [...approved.keys()]
				.filter((digest) => !retired.has(digest))
				.map((digest) => ({
					version: digest,
					rank: digest,
					artifact: create(ArtifactRefSchema, {
						name: railId,
						kind: ArtifactKind.UNSPECIFIED,
						digest,
						coordinate: railCoordinate(railId, digest),
					}),
				}));
			const limited = candidates.slice(
				Math.max(0, candidates.length - discoveryLimit(input.subscription)),
			);
			const cursor =
				at === undefined
					? writeCursor(previous)
					: writeCursor({ ...previous, at });
			return {
				ok: true,
				value: {
					artifacts: limited.map((item) => discovered(input, item, ctx)),
					cursor,
				},
			};
		},
	};
}
