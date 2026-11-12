// Shared discovery pipeline for version-listing drivers (OCI, Git tags,
// package registries, HTTP index): filter, forward-only selection above the
// high-water mark, newest-N limit, and the cursor that carries the mark.
import { create } from "@bufbuild/protobuf";
import type { JsonValue } from "@hobo/core";
import {
	type ArtifactRef,
	type DiscoveredArtifactRecord,
	DiscoveredArtifactRecordSchema,
	SelectionStrategy,
	type SubscriptionRecord,
} from "../../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../../events.js";
import type { CdContext, Outcome } from "../../ports.js";
import { field, isRecord, isText, parseJson } from "../json.js";
import { selectNewest, versionAllowed } from "../selection.js";

export type Candidate = Readonly<{
	version: string;
	/** Ordering key: the version for SEMVER/LEXICAL, a sortable timestamp for NEWEST_*. */
	rank: string;
	artifact: ArtifactRef;
	commit?: string;
}>;

type MutableCursor = { hw?: string; at?: string };
export type DriverCursor = Readonly<MutableCursor>;

export function parseCursor(cursor: string | undefined): DriverCursor {
	if (cursor === undefined || cursor === "") return {};
	const value: JsonValue | undefined = parseJson(cursor);
	if (!isRecord(value)) return {};
	const hw = field(value, "hw");
	const at = field(value, "at");
	const out: MutableCursor = {};
	if (isText(hw)) out.hw = hw;
	if (isText(at)) out.at = at;
	return out;
}

export function writeCursor(cursor: DriverCursor): string {
	const out: Record<string, string> = {};
	if (cursor.hw !== undefined) out.hw = cursor.hw;
	if (cursor.at !== undefined) out.at = cursor.at;
	return JSON.stringify(out);
}

export function discoveryLimit(subscription: SubscriptionRecord): number {
	return subscription.discoveryLimit > 0
		? subscription.discoveryLimit
		: CD_DEFAULTS.sourceDiscoveryLimit;
}

function rankStrategy(selection: SelectionStrategy): SelectionStrategy {
	return selection === SelectionStrategy.SEMVER
		? SelectionStrategy.SEMVER
		: SelectionStrategy.LEXICAL;
}

export type Selection = Readonly<{
	selected: readonly Candidate[];
	cursor: string;
}>;

/** Filter, then pick the newest `limit` strictly above the cursor's mark, oldest first. */
export function selectCandidates(
	subscription: SubscriptionRecord,
	candidates: readonly Candidate[],
	cursor: string | undefined,
): Selection {
	const previous = parseCursor(cursor);
	const allowed = candidates.filter(
		(item) => versionAllowed(subscription, item.version).ok,
	);
	const byRank = new Map<string, Candidate>();
	for (const item of allowed)
		if (!byRank.has(item.rank)) byRank.set(item.rank, item);
	const strategy = rankStrategy(subscription.selection);
	const ranks = selectNewest(
		strategy,
		[...byRank.keys()],
		discoveryLimit(subscription),
		previous.hw,
	);
	const selected = ranks.flatMap((rank) => {
		const found = byRank.get(rank);
		return found ? [found] : [];
	});
	const last = selected.at(-1);
	return {
		selected,
		cursor: writeCursor(last ? { ...previous, hw: last.rank } : previous),
	};
}

export function discovered(
	input: Readonly<{ source: string; subscription: SubscriptionRecord }>,
	candidate: Candidate,
	ctx: CdContext,
): DiscoveredArtifactRecord {
	return create(DiscoveredArtifactRecordSchema, {
		source: input.source,
		subscription: input.subscription.name,
		artifact: candidate.artifact,
		version: candidate.version,
		commit: candidate.commit ?? "",
		discoveredAt: new Date(ctx.now()).toISOString(),
		provenance: [],
	});
}

export function toDiscovery(
	input: Readonly<{
		source: string;
		subscription: SubscriptionRecord;
		cursor?: string;
	}>,
	candidates: readonly Candidate[],
	ctx: CdContext,
): Outcome<
	Readonly<{ artifacts: readonly DiscoveredArtifactRecord[]; cursor: string }>
> {
	const picked = selectCandidates(input.subscription, candidates, input.cursor);
	return {
		ok: true,
		value: {
			artifacts: picked.selected.map((item) => discovered(input, item, ctx)),
			cursor: picked.cursor,
		},
	};
}
