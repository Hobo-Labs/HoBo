// GIT_REPOSITORY subscriptions over smart HTTP protocol v2 against any host:
// capability advertisement, `ls-refs` with branch/tag prefixes, and a
// `deepen 1` fetch of the candidate commits (trees only, `filter blob:none`,
// or the commit alone, `filter tree:0`, when no path filter is set).
//
// The artifact digest is the declaration's identity:
// - no path filters: sha256 over `hobo.cd.git-tree/v1\nroot <tree oid>\n`;
// - with include/exclude paths: sha256 over `hobo.cd.git-paths/v1\n` plus one
//   `<mode> <oid> <path>\n` line per file the filters keep, sorted by path.
// A branch head whose filtered digest equals the last discovered one is not a
// new declaration and is not discovered.
import { create } from "@bufbuild/protobuf";
import type { HttpTransport } from "@hobo/core";
import {
	ArtifactKind,
	ArtifactRefSchema,
	type DiscoveredArtifactRecord,
	SelectionStrategy,
	SubscriptionKind,
	type SubscriptionRecord,
} from "../../_generated/cd_pb.js";
import type { CdContext, CredentialResolver, Outcome, SubscriptionDriver } from "../../ports.js";
import { bodyBytes, credentialHeaders, fetchSource, redactUrl, SOURCE_HTTP_MAX_BYTES, upstreamInvalid } from "../http.js";
import { field, isRecord, isText, parseJson, sha256Hex } from "../json.js";
import { refuse, SOURCE_REASON } from "../reasons.js";
import { type Candidate, discovered, selectCandidates } from "./common.js";
import {
	DELIM,
	FLUSH,
	GitFormatError,
	type GitObject,
	type ObjectFormat,
	fetchPackfile,
	parseCapabilities,
	parseCommit,
	parseLsRefs,
	pktLine,
	readPack,
	walkTree,
} from "./git-pack.js";
import { safeHttpsUrl } from "./http-index.js";

// public-contract: the agent string sent with every Git v2 command.
export const GIT_AGENT = "hobo-cd/1";
export const GIT_MAX_PACK_BYTES = 64 * 1024 * 1024;
const BRANCH = /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\.lock$)[A-Za-z0-9._/-]{1,200}$/;

export type GitCursor = Readonly<{ hw?: string; at?: string; tree?: string }>;

function parseGitCursor(cursor: string | undefined): GitCursor {
	const value = cursor ? parseJson(cursor) : undefined;
	if (!isRecord(value)) return {};
	const out: { hw?: string; at?: string; tree?: string } = {};
	for (const key of ["hw", "at", "tree"] as const) {
		const item = field(value, key);
		if (isText(item)) out[key] = item;
	}
	return out;
}

function writeGitCursor(cursor: GitCursor): string {
	const out: Record<string, string> = {};
	if (cursor.hw !== undefined) out.hw = cursor.hw;
	if (cursor.at !== undefined) out.at = cursor.at;
	if (cursor.tree !== undefined) out.tree = cursor.tree;
	return JSON.stringify(out);
}

function under(path: string, prefix: string): boolean {
	const clean = prefix.replace(/^\/+|\/+$/g, "");
	return clean === "" || path === clean || path.startsWith(`${clean}/`);
}

/** The declaration digest of one commit (see the module comment). */
export function treeDigest(
	objects: ReadonlyMap<string, GitObject>,
	commit: Readonly<{ tree: string }>,
	subscription: Pick<SubscriptionRecord, "includePaths" | "excludePaths">,
	format: ObjectFormat,
): string {
	if (subscription.includePaths.length === 0 && subscription.excludePaths.length === 0) {
		return `sha256:${sha256Hex(`hobo.cd.git-tree/v1\nroot ${commit.tree}\n`)}`;
	}
	const lines = walkTree(objects, commit.tree, format)
		.filter(
			(file) =>
				(subscription.includePaths.length === 0 || subscription.includePaths.some((prefix) => under(file.path, prefix))) &&
				!subscription.excludePaths.some((prefix) => under(file.path, prefix)),
		)
		.map((file) => `${file.mode} ${file.oid} ${file.path}\n`)
		.sort();
	return `sha256:${sha256Hex(`hobo.cd.git-paths/v1\n${lines.join("")}`)}`;
}

/** The v2 request body for `ls-refs` restricted to `prefix`. */
export function lsRefsRequest(prefix: string, format: ObjectFormat): string {
	return [
		pktLine("command=ls-refs\n"),
		pktLine(`agent=${GIT_AGENT}\n`),
		...(format === "sha256" ? [pktLine("object-format=sha256\n")] : []),
		DELIM,
		pktLine("peel\n"),
		pktLine(`ref-prefix ${prefix}\n`),
		FLUSH,
	].join("");
}

/** The v2 request body for a shallow, filtered fetch of `wants`. */
export function fetchRequest(wants: readonly string[], filter: string, format: ObjectFormat): string {
	return [
		pktLine("command=fetch\n"),
		pktLine(`agent=${GIT_AGENT}\n`),
		...(format === "sha256" ? [pktLine("object-format=sha256\n")] : []),
		DELIM,
		pktLine("no-progress\n"),
		pktLine("ofs-delta\n"),
		pktLine("deepen 1\n"),
		pktLine(`filter ${filter}\n`),
		...[...new Set(wants)].sort().map((oid) => pktLine(`want ${oid}\n`)),
		pktLine("done\n"),
		FLUSH,
	].join("");
}

type Session = Readonly<{
	base: string;
	headers: Readonly<Record<string, string>>;
	format: ObjectFormat;
	fetchFeatures: ReadonlySet<string>;
}>;

const POST_HEADERS = {
	"git-protocol": "version=2",
	"content-type": "application/x-git-upload-pack-request",
	accept: "application/x-git-upload-pack-result",
} as const;

function gitError(where: string, error: GitFormatError) {
	return upstreamInvalid(where, error.message);
}

export function createGitDriver(d: Readonly<{ http: HttpTransport; credentials?: CredentialResolver }>): SubscriptionDriver {
	async function open(subscription: SubscriptionRecord, ctx: CdContext): Promise<Outcome<Session>> {
		const base = subscription.locator.replace(/\/+$/, "");
		const auth = await credentialHeaders(d.credentials, subscription.credentialRef);
		if (!auth.ok) return auth;
		const response = await fetchSource(
			d.http,
			{ url: `${base}/info/refs?service=git-upload-pack`, headers: { ...auth.value, "git-protocol": "version=2" } },
			ctx.now(),
		);
		if (!response.ok) return response;
		const bytes = bodyBytes(response.value, redactUrl(base));
		if (!bytes.ok) return bytes;
		let advert: ReturnType<typeof parseCapabilities>;
		try {
			advert = parseCapabilities(bytes.value);
		} catch (error) {
			return error instanceof GitFormatError ? gitError(redactUrl(base), error) : upstreamInvalid(redactUrl(base), "unreadable advertisement");
		}
		const fetch = advert.capabilities.get("fetch");
		if (advert.version !== 2 || !advert.capabilities.has("ls-refs") || fetch === undefined) {
			return refuse(
				SOURCE_REASON.gitCapabilityMissing,
				`${redactUrl(base)} does not speak Git protocol v2 (ls-refs and fetch)`,
				"enable protocol v2 on the Git server (protocol.version=2); every major host supports it",
				redactUrl(base),
			);
		}
		const format: ObjectFormat = advert.capabilities.get("object-format") === "sha256" ? "sha256" : "sha1";
		return { ok: true, value: { base, headers: auth.value, format, fetchFeatures: new Set(fetch.split(" ")) } };
	}

	async function post(session: Session, body: string, ctx: CdContext, maxResponseBytes?: number): Promise<Outcome<Uint8Array>> {
		const response = await fetchSource(
			d.http,
			{
				method: "POST",
				url: `${session.base}/git-upload-pack`,
				headers: { ...session.headers, ...POST_HEADERS },
				body,
				maxResponseBytes: maxResponseBytes ?? SOURCE_HTTP_MAX_BYTES,
			},
			ctx.now(),
		);
		if (!response.ok) return response;
		return bodyBytes(response.value, redactUrl(session.base));
	}

	async function fetchObjects(
		session: Session,
		wants: readonly string[],
		withTrees: boolean,
		ctx: CdContext,
	): Promise<Outcome<ReadonlyMap<string, GitObject>>> {
		const where = redactUrl(session.base);
		if (!session.fetchFeatures.has("shallow") || !session.fetchFeatures.has("filter")) {
			return refuse(
				SOURCE_REASON.gitCapabilityMissing,
				`${where} does not advertise fetch shallow and filter`,
				"enable uploadpack.allowFilter on the Git server; discovery reads trees only and never clones",
				where,
			);
		}
		const body = await post(session, fetchRequest(wants, withTrees ? "blob:none" : "tree:0", session.format), ctx, GIT_MAX_PACK_BYTES);
		if (!body.ok) return body;
		try {
			return { ok: true, value: readPack(fetchPackfile(body.value), session.format) };
		} catch (error) {
			return error instanceof GitFormatError ? gitError(where, error) : upstreamInvalid(where, "unreadable packfile");
		}
	}

	function artifactFor(subscription: SubscriptionRecord, oid: string, digest: string) {
		return create(ArtifactRefSchema, {
			name: subscription.artifactName || subscription.name,
			kind: subscription.artifactKind || ArtifactKind.SOURCE_TREE,
			digest,
			coordinate: `${redactUrl(subscription.locator)}@${oid}`,
			ecosystem: "git",
		});
	}

	return {
		kind: SubscriptionKind.GIT_REPOSITORY,
		async discover(input, ctx) {
			const { subscription } = input;
			if (!safeHttpsUrl(subscription.locator)) {
				return refuse(SOURCE_REASON.invalid, "Git locator must be an https URL without credentials", "use https://host/owner/repo.git and a credentialRef", "locator");
			}
			if (subscription.branch !== "" && !BRANCH.test(subscription.branch)) {
				return refuse(SOURCE_REASON.invalid, `branch ${JSON.stringify(subscription.branch)} is not a valid ref name`, "name a branch such as main or release/1.x", "branch");
			}
			const session = await open(subscription, ctx);
			if (!session.ok) return session;
			const where = redactUrl(session.value.base);
			const prefix = subscription.branch !== "" ? `refs/heads/${subscription.branch}` : "refs/tags/";
			const listed = await post(session.value, lsRefsRequest(prefix, session.value.format), ctx);
			if (!listed.ok) return listed;
			let refs: ReturnType<typeof parseLsRefs>;
			try {
				refs = parseLsRefs(listed.value);
			} catch (error) {
				return error instanceof GitFormatError ? gitError(where, error) : upstreamInvalid(where, "unreadable ls-refs");
			}
			const withTrees = subscription.includePaths.length > 0 || subscription.excludePaths.length > 0;
			const previous = parseGitCursor(input.cursor);
			if (subscription.branch !== "") return discoverBranch(input, ctx, session.value, refs, previous, withTrees);
			// Tags: SemVer or lexical selection over tag names, newest N above the mark.
			const tags = refs
				.filter((ref) => ref.name.startsWith("refs/tags/"))
				.map((ref) => ({ version: ref.name.slice("refs/tags/".length), oid: ref.peeled ?? ref.oid }));
			const commitOf = new Map(tags.map((tag) => [tag.version, tag.oid]));
			const picked = selectCandidates(
				subscription,
				tags.map((tag) => ({ version: tag.version, rank: tag.version, artifact: create(ArtifactRefSchema, {}) })),
				previous.hw === undefined ? undefined : writeGitCursor({ hw: previous.hw }),
			);
			if (picked.selected.length === 0) return { ok: true, value: { artifacts: [], cursor: writeGitCursor(previous) } };
			const wants = picked.selected.flatMap((item) => {
				const oid = commitOf.get(item.version);
				return oid ? [oid] : [];
			});
			const objects = await fetchObjects(session.value, wants, withTrees, ctx);
			if (!objects.ok) return objects;
			const artifacts: DiscoveredArtifactRecord[] = [];
			for (const item of picked.selected) {
				const oid = commitOf.get(item.version) ?? "";
				const object = objects.value.get(oid);
				if (object?.type !== "commit") return upstreamInvalid(where, `tag ${item.version} does not point at a fetched commit`);
				try {
					const commit = parseCommit(object.data);
					const digest = treeDigest(objects.value, commit, subscription, session.value.format);
					const candidate: Candidate = { ...item, artifact: artifactFor(subscription, oid, digest), commit: oid };
					artifacts.push(discovered(input, candidate, ctx));
				} catch (error) {
					return error instanceof GitFormatError ? gitError(where, error) : upstreamInvalid(where, "unreadable commit");
				}
			}
			const last = picked.selected.at(-1);
			return { ok: true, value: { artifacts, cursor: writeGitCursor(last ? { ...previous, hw: last.rank } : previous) } };
		},
	};

	async function discoverBranch(
		input: Parameters<SubscriptionDriver["discover"]>[0],
		ctx: CdContext,
		session: Session,
		refs: ReturnType<typeof parseLsRefs>,
		previous: GitCursor,
		withTrees: boolean,
	): Promise<Outcome<Readonly<{ artifacts: readonly DiscoveredArtifactRecord[]; cursor: string }>>> {
		const { subscription } = input;
		const where = redactUrl(session.base);
		const head = refs.find((ref) => ref.name === `refs/heads/${subscription.branch}`);
		if (!head) {
			return refuse(SOURCE_REASON.notFound, `${where} has no branch ${subscription.branch}`, "fix the subscription branch", subscription.branch);
		}
		if (head.oid === previous.at) return { ok: true, value: { artifacts: [], cursor: writeGitCursor(previous) } };
		const objects = await fetchObjects(session, [head.oid], withTrees, ctx);
		if (!objects.ok) return objects;
		const object = objects.value.get(head.oid);
		if (object?.type !== "commit") return upstreamInvalid(where, `branch head ${head.oid} was not fetched`);
		try {
			const commit = parseCommit(object.data);
			// Forward-only: a head older than the mark (a force-push backwards) is not discovered.
			const rank = `${String(commit.committedAtMs).padStart(15, "0")}\u0000${head.oid}`;
			if (previous.hw !== undefined && rank <= previous.hw) {
				return { ok: true, value: { artifacts: [], cursor: writeGitCursor({ ...previous, at: head.oid }) } };
			}
			const digest = treeDigest(objects.value, commit, subscription, session.format);
			const cursor = writeGitCursor({ hw: rank, at: head.oid, tree: digest });
			if (digest === previous.tree) return { ok: true, value: { artifacts: [], cursor } };
			const candidate: Candidate = {
				version: head.oid,
				rank,
				artifact: artifactFor(subscription, head.oid, digest),
				commit: head.oid,
			};
			return { ok: true, value: { artifacts: [discovered(input, candidate, ctx)], cursor } };
		} catch (error) {
			return error instanceof GitFormatError ? gitError(where, error) : upstreamInvalid(where, "unreadable commit");
		}
	}
}

/** Selections a Git subscription accepts: tags by SemVer/lexical, a branch by newest commit. */
export function gitSelectionAllowed(subscription: Pick<SubscriptionRecord, "branch" | "selection">): boolean {
	if (subscription.branch !== "") {
		return subscription.selection === SelectionStrategy.NEWEST_COMMIT || subscription.selection === SelectionStrategy.UNSPECIFIED;
	}
	return subscription.selection !== SelectionStrategy.NEWEST_BUILD && subscription.selection !== SelectionStrategy.NEWEST_COMMIT;
}
