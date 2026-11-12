// HTTP_INDEX subscriptions: a JSON list of `{version, url, digest}` (bare
// array, or `{items: [...]}`), optionally with `commit`, `createdAt`, `size`
// and `mediaType`. Entries with a non-sha256 digest, a non-https URL or URL
// credentials are dropped: the index is read, never trusted blindly.
import { create } from "@bufbuild/protobuf";
import type { HttpTransport, JsonValue } from "@hobo/core";
import {
	ArtifactKind,
	ArtifactRefSchema,
	SelectionStrategy,
	SubscriptionKind,
} from "../../_generated/cd_pb.js";
import type { CredentialResolver, SubscriptionDriver } from "../../ports.js";
import { credentialHeaders, fetchSource, upstreamInvalid } from "../http.js";
import {
	field,
	isDigest,
	isList,
	isNumeric,
	list,
	parseJson,
	text,
} from "../json.js";
import { type Candidate, toDiscovery } from "./common.js";

const COMMIT = /^[0-9a-f]{7,64}$/;

export function safeHttpsUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" && url.username === "" && url.password === ""
		);
	} catch {
		return false;
	}
}

function entriesOf(
	document: JsonValue | undefined,
): readonly JsonValue[] | undefined {
	if (isList(document)) return document;
	const items = list(document, "items");
	return items.length > 0 || isList(document) ? items : undefined;
}

export function createHttpIndexDriver(
	d: Readonly<{ http: HttpTransport; credentials?: CredentialResolver }>,
): SubscriptionDriver {
	return {
		kind: SubscriptionKind.HTTP_INDEX,
		async discover(input, ctx) {
			const { subscription } = input;
			const auth = await credentialHeaders(
				d.credentials,
				subscription.credentialRef,
			);
			if (!auth.ok) return auth;
			const response = await fetchSource(
				d.http,
				{
					url: subscription.locator,
					headers: { ...auth.value, accept: "application/json" },
				},
				ctx.now(),
			);
			if (!response.ok) return response;
			const entries = entriesOf(parseJson(response.value.body));
			if (!entries)
				return upstreamInvalid(
					subscription.locator,
					"index is not a JSON list or {items: [...]}",
				);
			const candidates: Candidate[] = [];
			for (const entry of entries) {
				const version = text(entry, "version");
				const url = text(entry, "url");
				const digest = text(entry, "digest");
				if (
					!version ||
					!url ||
					!digest ||
					!isDigest(digest) ||
					!safeHttpsUrl(url)
				)
					continue;
				const createdAt = text(entry, "createdAt");
				const newest =
					subscription.selection === SelectionStrategy.NEWEST_BUILD;
				if (newest && (!createdAt || Number.isNaN(Date.parse(createdAt))))
					continue;
				const size = field(entry, "size");
				const commit = text(entry, "commit");
				const artifact = create(ArtifactRefSchema, {
					name: subscription.artifactName || subscription.name,
					kind: subscription.artifactKind || ArtifactKind.STATIC_ASSETS,
					digest,
					coordinate: url,
					mediaType: text(entry, "mediaType") ?? "",
					ecosystem: "http",
					sizeBytes:
						isNumeric(size) && Number.isSafeInteger(size) && size >= 0
							? BigInt(size)
							: 0n,
				});
				const rank =
					newest && createdAt
						? `${new Date(createdAt).toISOString()}\u0000${version}`
						: version;
				candidates.push(
					commit && COMMIT.test(commit)
						? { version, rank, artifact, commit }
						: { version, rank, artifact },
				);
			}
			return toDiscovery(input, candidates, ctx);
		},
	};
}
