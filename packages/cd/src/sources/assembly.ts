// Assembly rules (D3): turn newly discovered artifacts into Freight manifests,
// one per qualifying combination. Pure and order-independent for a given
// history: no clock, no I/O.
//
// - INDEPENDENT: each new artifact with the latest artifact of every other
//   subscription (none yet → no Freight until one exists).
// - SAME_VERSION / SAME_COMMIT: one artifact per subscription sharing the
//   version / commit; a key is assembled once all subscriptions have it.
//
// The declaration hash is the SOURCE_TREE member's digest when the source has
// a declaration subscription; otherwise the digest of the source definition
// (bindle + subscriptions), so a source without a declaration still yields a
// stable, content-derived declaration. A HOBO_RAIL source yields subject RAIL:
// bindle = Rail id, declaration hash = Rail digest, no artifacts (D24).
import { create, toJson } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	type ArtifactRef,
	AssemblyRule,
	type DiscoveredArtifactRecord,
	type FreightManifestRecord,
	FreightManifestRecordSchema,
	type FreightSourceRecord,
	FreightSubject,
	type ProvenanceRef,
	SourceRefSchema,
	SubscriptionKind,
	SubscriptionRecordSchema,
} from "../_generated/cd_pb.js";
import { FREIGHT_MANIFEST_SCHEMA } from "../events.js";
import { canonical, sha256Digest } from "./json.js";

// public-contract: the label every discovered Freight carries naming its source.
export const SOURCE_LABEL = "hobo.cd/source" as const;

export type Assembled = Readonly<{ manifest: FreightManifestRecord; members: readonly DiscoveredArtifactRecord[] }>;

export type AssemblyInput = Readonly<{
	source: FreightSourceRecord;
	/** Previously discovered (and not skipped) artifacts, oldest first. */
	history: readonly DiscoveredArtifactRecord[];
	/** Newly discovered artifacts eligible for Freight, oldest first. */
	fresh: readonly DiscoveredArtifactRecord[];
}>;

export type Deferred = Readonly<{ artifact: DiscoveredArtifactRecord; waitingFor: readonly string[] }>;

/** Digest of the source definition used when no subscription supplies the declaration. */
export function definitionDigest(source: FreightSourceRecord): string {
	return sha256Digest(
		canonical({
			bindle: source.bindle,
			assembly: AssemblyRule[source.assembly] ?? "",
			subscriptions: source.subscriptions.map((item) => toJson(SubscriptionRecordSchema, item)),
		}),
	);
}

function isDeclaration(artifact: ArtifactRef | undefined): boolean {
	return artifact?.kind === ArtifactKind.SOURCE_TREE;
}

function latestPerSubscription(records: readonly DiscoveredArtifactRecord[]): Map<string, DiscoveredArtifactRecord> {
	const latest = new Map<string, DiscoveredArtifactRecord>();
	for (const record of records) latest.set(record.subscription, record);
	return latest;
}

function manifestFor(source: FreightSourceRecord, members: readonly DiscoveredArtifactRecord[]): FreightManifestRecord {
	const rail = source.subscriptions.some((item) => item.kind === SubscriptionKind.HOBO_RAIL);
	const labels = { [SOURCE_LABEL]: source.name };
	if (rail) {
		const member = members[0];
		return create(FreightManifestRecordSchema, {
			schemaVersion: FREIGHT_MANIFEST_SCHEMA,
			bindle: source.bindle,
			declarationHash: member?.artifact?.digest ?? "",
			artifacts: [],
			subject: FreightSubject.RAIL,
			labels,
		});
	}
	const ordered = [...members].sort((left, right) => left.subscription.localeCompare(right.subscription));
	const declaration = ordered.find((item) => isDeclaration(item.artifact));
	const git = ordered.find((item) => item.artifact?.ecosystem === "git");
	const ci = source.subscriptions.find((item) => item.kind === SubscriptionKind.HOBO_CI);
	const ciMember = ci ? ordered.find((item) => item.subscription === ci.name) : undefined;
	const commit = ordered.find((item) => item.commit !== "")?.commit ?? "";
	const provenance: ProvenanceRef[] = [];
	const seen = new Set<string>();
	for (const member of ordered) {
		for (const ref of member.provenance) {
			if (seen.has(ref.statementDigest)) continue;
			seen.add(ref.statementDigest);
			provenance.push(ref);
		}
	}
	const sourceRef = create(SourceRefSchema, {
		repository: git?.artifact?.coordinate.replace(/@[0-9a-f]+$/, "") ?? "",
		commit,
		ref: git && git.version !== git.commit ? git.version : "",
		ciRunId: ciMember?.version ?? "",
		ciSystem: ciMember ? "hobo-ci" : "",
	});
	return create(FreightManifestRecordSchema, {
		schemaVersion: FREIGHT_MANIFEST_SCHEMA,
		bindle: source.bindle,
		declarationHash: declaration?.artifact?.digest ?? definitionDigest(source),
		artifacts: ordered.flatMap((item) => (item.artifact ? [item.artifact] : [])),
		source: sourceRef,
		provenance,
		labels,
		subject: FreightSubject.BINDLE,
	});
}

function comboKey(members: readonly DiscoveredArtifactRecord[]): string {
	return members
		.map((item) => `${item.subscription}=${item.artifact?.digest ?? ""}@${item.version}`)
		.sort()
		.join("|");
}

export function assemble(input: AssemblyInput): Readonly<{ freight: readonly Assembled[]; deferred: readonly Deferred[] }> {
	const { source } = input;
	const subscriptions = source.subscriptions.map((item) => item.name);
	const freight: Assembled[] = [];
	const deferred: Deferred[] = [];
	const emitted = new Set<string>();
	const push = (members: readonly DiscoveredArtifactRecord[]) => {
		const key = comboKey(members);
		if (emitted.has(key)) return;
		emitted.add(key);
		freight.push({ manifest: manifestFor(source, members), members });
	};
	if (source.assembly === AssemblyRule.SAME_VERSION || source.assembly === AssemblyRule.SAME_COMMIT) {
		const keyOf = (item: DiscoveredArtifactRecord) => (source.assembly === AssemblyRule.SAME_VERSION ? item.version : item.commit);
		const all = [...input.history, ...input.fresh];
		for (const item of input.fresh) {
			const key = keyOf(item);
			const matching = latestPerSubscription(all.filter((candidate) => key !== "" && keyOf(candidate) === key));
			matching.set(item.subscription, item);
			const missing = subscriptions.filter((name) => !matching.has(name));
			if (key === "" || missing.length > 0) {
				deferred.push({ artifact: item, waitingFor: key === "" ? subscriptions : missing });
				continue;
			}
			push(subscriptions.flatMap((name) => matching.get(name) ?? []));
		}
		return { freight, deferred };
	}
	const latest = latestPerSubscription(input.history);
	for (const item of input.fresh) {
		latest.set(item.subscription, item);
		const missing = subscriptions.filter((name) => !latest.has(name));
		if (missing.length > 0) {
			deferred.push({ artifact: item, waitingFor: missing });
			continue;
		}
		push(subscriptions.flatMap((name) => (name === item.subscription ? [item] : (latest.get(name) ?? []))));
	}
	return { freight, deferred };
}
