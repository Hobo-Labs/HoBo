#!/usr/bin/env node
/**
 * HoBo releases itself through HoBo CD, then creates the GitHub Release.
 *
 * Release Freight: every release artifact family (npm tarballs, GHCR images by
 * digest, the Pages site tree) is recorded as Freight with its provenance (the
 * release commit, the run and the workflow as builder) and promoted
 * `hobo-release/<family>-candidate` -> `hobo-release/<family>-stable` through
 * the `hobo deploy` composition of `@hobo/cd` (`openCdRuntime` and
 * `runCdDeploySubcommand` from the built `@hobo/hobo`, the code the `hobo
 * deploy` verb runs), with the release topology loaded from
 * `release/hobo-release.delivery.ts` exactly as `--yard` loads it. The Camps'
 * realizers publish: the catalogued resolvers of `@hobo/provider-oci-registry`
 * (GHCR tags by digest) and `@hobo/provider-github` (the gh-pages branch).
 *
 * A promotion is driven here the way `hobo serve cd` ticks it (promotions,
 * one conductor pass of the Camp, rollouts, verification) until it is
 * PROMOTED, refused, or the realizer reports BLOCKED. The verdict is
 * `qualified`, `impedance` (the realizer refused only with a named npm
 * provider limit, RELEASE_IMPEDANCE_CODES; only npm, see
 * live-provider-matrix.md) or `blocked`.
 *
 *   create-github-release.mts promote-stable --freight-home <dir> [...]
 *   create-github-release.mts --tag <tag> [--prerelease]
 *
 * The GitHub Release is created through the REST API directly: the release
 * runners have no `gh` CLI (the runner image does not install it).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Release Freight ─────────────────────────────────────────────────────────

const repoRoot = join(import.meta.dirname, "..", "..");

/** The built `hobo` package whose `hobo deploy` composition records and promotes. */
export const HOBO_CLI_DIST = join(
	repoRoot,
	"packages",
	"hobo",
	"dist",
	"index.js",
);
const HOBO_CD_RUNTIME_DIST = join(
	repoRoot,
	"packages",
	"hobo",
	"dist",
	"cd-runtime.js",
);
const CD_DIST = join(repoRoot, "packages", "cd", "dist", "index.js");
const BINDLES_DIST = join(repoRoot, "packages", "bindles", "dist", "index.js");

/** The release topology (`--yard`): the hobo-release Yard and its pipelines. */
export const RELEASE_DELIVERY_MODULE = join(
	repoRoot,
	"release",
	"hobo-release.delivery.ts",
);

export type ReleaseFamily = "npm" | "oci" | "pages";
export type ReleaseChannel = "candidate" | "stable";

export const RELEASE_FAMILIES: readonly ReleaseFamily[] = [
	"npm",
	"oci",
	"pages",
];
export const RELEASE_YARD = "hobo-release";

/** `<yard>/<family>-<channel>`: the Camp a family's channel promotes into. */
export function releaseCampId(
	family: ReleaseFamily,
	channel: ReleaseChannel,
): string {
	return `${RELEASE_YARD}/${family}-${channel}`;
}

export function releaseBindle(family: ReleaseFamily): string {
	return `hobo-release-${family}`;
}

// The one product each family's Camp realizes (CATALOG_REALIZED_PRODUCTS).
const FAMILY_PRODUCT = {
	npm: "npm.package-version/v1",
	oci: "oci-registry.image/v1",
	pages: "github.pages-site/v1",
} as const satisfies Record<ReleaseFamily, string>;

/**
 * The exact realizer refusals that name an npm provider limit, not a broken
 * release: OIDC trusted publishing of a scoped package (which
 * @hobo/provider-npm refuses) and a provenance-required Camp whose Freight
 * carries no Sigstore bundle (the release scripts record none yet). Only the
 * npm family reads them: its `npm publish --provenance` step stays the
 * publisher on exactly these codes (an unmet requirement, release-channels.md).
 * Anything else, including RESOLVER_PRODUCT_UNSUPPORTED and
 * catalog-binding-invalid (a misdeclared Camp or Freight), blocks.
 */
export const RELEASE_IMPEDANCE_CODES: ReadonlySet<string> = new Set([
	"npm-oidc-scoped-unsupported",
	"npm-provenance-bundle-missing",
]);

/** Families whose publisher may stay an existing workflow step on `impedance`. */
export const RELEASE_IMPEDANCE_FAMILIES: ReadonlySet<ReleaseFamily> = new Set([
	"npm",
]);

export type ReleaseSource = Readonly<{
	repository: string;
	commit: string;
	ref: string;
	ciRunId: string;
	ciSystem: string;
	builderId: string;
}>;

/** The release's source, from the Actions env (or the local checkout). */
export function releaseSource(
	env: Readonly<Record<string, string | undefined>>,
): ReleaseSource {
	const commit = (
		env.HOBO_RELEASE_REVISION ||
		env.GITHUB_SHA ||
		spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })
			.stdout ||
		""
	).trim();
	if (!/^[0-9a-f]{7,64}$/u.test(commit))
		throw new Error(
			`release Freight needs the release commit as a git sha, got "${commit}" (set HOBO_RELEASE_REVISION)`,
		);
	const repository = env.GITHUB_REPOSITORY?.trim() || "Hobo-Labs/HoBo";
	return {
		repository,
		commit,
		ref: env.GITHUB_REF?.trim() ?? "",
		ciRunId: env.GITHUB_RUN_ID?.trim() ?? "",
		ciSystem:
			env.GITHUB_ACTIONS === "true" || env.GITHUB_RUN_ID
				? "github-actions"
				: "local",
		builderId: `https://github.com/${repository}/.github/workflows/release-hobo.yml`,
	};
}

/** The `hobo.cd.v1.ArtifactKind` names a release artifact may carry. */
export type ArtifactKindName =
	| "ARTIFACT_KIND_FUNCTION_BUNDLE"
	| "ARTIFACT_KIND_STATIC_ASSETS"
	| "ARTIFACT_KIND_OCI_IMAGE"
	| "ARTIFACT_KIND_PACKAGE"
	| "ARTIFACT_KIND_SOURCE_TREE";

export type ReleaseArtifact = Readonly<{
	name: string;
	kind: ArtifactKindName;
	digest: string;
	coordinate: string;
	ecosystem: string;
	mediaType: string;
	sizeBytes?: string;
}>;

/** One family's `hobo.freight-manifest/v1` (protobuf JSON form). */
export function releaseFreightManifest(input: {
	readonly family: ReleaseFamily;
	readonly declarationHash: string;
	readonly source: ReleaseSource;
	readonly artifacts: readonly ReleaseArtifact[];
	readonly labels?: Readonly<Record<string, string>> | undefined;
}) {
	return {
		schemaVersion: "hobo.freight-manifest/v1",
		bindle: releaseBindle(input.family),
		declarationHash: input.declarationHash,
		artifacts: [...input.artifacts].sort((a, b) =>
			a.name.localeCompare(b.name),
		),
		source: { ...input.source },
		labels: { ...input.labels, "hobo.release/family": input.family },
	};
}

/**
 * The family's declaration: a Bindle with one resource whose port names the
 * product its Camps realize, so Matching places it only on those Camps.
 */
export function releaseDeclaration(family: ReleaseFamily) {
	return {
		schema: "hobo.manifest/v1",
		componentHost: { kind: "hobo-release", version: "1" },
		resources: {
			release: { type: "data.v1", port: `hobo:${FAMILY_PRODUCT[family]}` },
		},
	};
}

// A `hobo deploy` result envelope, read structurally (protobuf JSON data).
type CdReason = { readonly code?: string; readonly message?: string };
type CdPromotion = {
	readonly promotionId?: string;
	readonly freightId?: string;
	readonly state?: string;
	readonly reasons?: readonly CdReason[];
};
export type CdResult = {
	readonly ok: boolean;
	readonly code?: string;
	readonly message?: string;
	readonly data?: {
		readonly reasons?: readonly CdReason[];
		readonly promotion?: CdPromotion;
		readonly freight?: { readonly freightId?: string; readonly alias?: string };
		readonly usable?: boolean;
	};
};

export type ReleaseVerdict = Readonly<{
	outcome: "qualified" | "impedance" | "blocked";
	codes: readonly string[];
	message: string;
	promotionId?: string;
}>;

/** One drive pass's view of a promotion and its Camp's last observation. */
export type ReleaseDriveState = Readonly<{
	/** `PROMOTION_STATE_*` name. */
	state: string;
	reasons: readonly CdReason[];
	/** `RECONCILE_STATUS_*` name of the Camp's last observation of this Set. */
	observed?: string;
	observedReasons?: readonly CdReason[];
}>;

const TERMINAL = new Set([
	"PROMOTION_STATE_PROMOTED",
	"PROMOTION_STATE_REJECTED",
	"PROMOTION_STATE_FAILED",
	"PROMOTION_STATE_ROLLED_BACK",
	"PROMOTION_STATE_SUPERSEDED",
]);

const codesOf = (reasons: readonly CdReason[] | undefined) =>
	(reasons ?? []).map((r) => r.code ?? "").filter((c) => c !== "");

/**
 * Read a driven promotion as a release verdict (fail closed): PROMOTED is the
 * only qualification; a realizer refusal is `impedance` only when every code
 * is a declared impedance code; anything else, including not finishing, blocks.
 */
export function classifyRelease(
	promotionId: string,
	at: ReleaseDriveState | undefined,
): ReleaseVerdict | undefined {
	if (!at) return undefined;
	if (at.state === "PROMOTION_STATE_PROMOTED")
		return {
			outcome: "qualified",
			codes: [],
			message: "promoted and qualified",
			promotionId,
		};
	if (at.observed === "RECONCILE_STATUS_BLOCKED") {
		const codes = codesOf(at.observedReasons);
		const impedance =
			codes.length > 0 && codes.every((c) => RELEASE_IMPEDANCE_CODES.has(c));
		return {
			outcome: impedance ? "impedance" : "blocked",
			codes,
			message: (at.observedReasons ?? []).map((r) => r.message).join("; "),
			promotionId,
		};
	}
	if (TERMINAL.has(at.state))
		return {
			outcome: "blocked",
			codes: codesOf(at.reasons).length
				? codesOf(at.reasons)
				: [at.state.toLowerCase()],
			message: (at.reasons ?? []).map((r) => r.message).join("; "),
			promotionId,
		};
	return undefined;
}

/** The `hobo deploy` composition opened on one HOBO_HOME with the release topology. */
export type ReleaseCd = Readonly<{
	home: string;
	run(
		args: readonly string[],
		flags?: Record<string, string>,
	): Promise<CdResult>;
	store(
		bytes: Uint8Array,
		meta: { name: string; kind: ArtifactKindName; mediaType: string },
	): Promise<ReleaseArtifact>;
	/** Canonical Bindle bytes and their `canonicalManifestHash`. */
	declaration(
		value: ReturnType<typeof releaseDeclaration>,
	): Promise<{ bytes: Uint8Array; digest: string }>;
	/** One drive pass of a promotion (the `hobo serve cd` steps for one Camp). */
	drive(promotionId: string, campId: string): Promise<ReleaseDriveState>;
	close(): Promise<void>;
}>;

// The ArtifactKind numbers of hobo.cd.v1 (packages/cd/data-models/cd.proto).
const ARTIFACT_KIND = {
	ARTIFACT_KIND_FUNCTION_BUNDLE: 2,
	ARTIFACT_KIND_STATIC_ASSETS: 3,
	ARTIFACT_KIND_OCI_IMAGE: 4,
	ARTIFACT_KIND_PACKAGE: 6,
	ARTIFACT_KIND_SOURCE_TREE: 7,
} as const;

/**
 * Test seams (recorded fixtures, offline): the `HttpTransport` the realizers,
 * Freight verification and probes use; the CD clock; how a promotion is driven.
 */
export type ReleaseCdSeams = Readonly<{
	http?: unknown;
	now?: () => number;
	drive?: { readonly passes: number; readonly intervalMs: number };
}>;

/**
 * Open the `hobo deploy` composition (SQLite journal and filesystem artifact
 * store under `home`) with `release/hobo-release.delivery.ts` as its topology,
 * the same file `hobo deploy --yard` loads. Credentials resolve through the
 * host's CredentialResolver (`env://NAME` locators the Camps declare), at call
 * time, for that call only.
 */
export async function openReleaseCd(options: {
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly seams?: ReleaseCdSeams;
}): Promise<ReleaseCd> {
	for (const dist of [
		HOBO_CLI_DIST,
		HOBO_CD_RUNTIME_DIST,
		CD_DIST,
		BINDLES_DIST,
	])
		if (!existsSync(dist))
			throw new Error(
				`release Freight needs the built hobo CLI (${dist}); run pnpm exec turbo run build --filter=@hobo/hobo...`,
			);
	const hobo = await import(pathToFileURL(HOBO_CLI_DIST).href);
	const runtimeModule = await import(pathToFileURL(HOBO_CD_RUNTIME_DIST).href);
	const cdModule = await import(pathToFileURL(CD_DIST).href);
	const bindles = await import(pathToFileURL(BINDLES_DIST).href);
	const env = {
		...options.env,
		HOBO_HOME: options.home,
		HOBO_USER: options.env.HOBO_USER || "hobo-release",
	};
	const opened = await runtimeModule.openCdRuntime({
		simulate: false,
		cwd: repoRoot,
		env,
		home: options.home,
		topologyFiles: [RELEASE_DELIVERY_MODULE],
		...(options.seams?.http ? { http: options.seams.http } : undefined),
		...(options.seams?.now ? { now: options.seams.now } : undefined),
	});
	if (!opened.ok)
		throw new Error(
			`hobo deploy could not open CD: ${JSON.stringify(opened.reasons)}`,
		);
	const runtime = opened.value;
	const { PromotionState, ReconcileStatus } = cdModule;
	return {
		home: options.home,
		run: async (args, flags = {}) =>
			hobo.runCdDeploySubcommand(runtime.host, args, {
				...flags,
				format: "json",
			}),
		async store(bytes, meta) {
			const kind = ARTIFACT_KIND[meta.kind];
			const ref = await runtime.cd.artifacts.put(
				bytes,
				{ name: meta.name, kind, mediaType: meta.mediaType },
				runtime.ctx,
			);
			return {
				name: ref.name,
				kind: meta.kind,
				digest: ref.digest,
				coordinate: ref.coordinate,
				ecosystem: ref.ecosystem,
				mediaType: ref.mediaType,
				sizeBytes: String(ref.sizeBytes),
			};
		},
		async declaration(value) {
			const manifest = bindles.parseManifest(value);
			return {
				bytes: new TextEncoder().encode(bindles.serializeManifest(manifest)),
				digest: bindles.canonicalManifestHash(manifest),
			};
		},
		async drive(promotionId, campId) {
			const ctx = runtime.ctx;
			await runtime.cd.promotions.tick(ctx);
			const set = await runtime.cd.desired.current(campId);
			let observed:
				| { status: number; setId: string; reasons: CdReason[] }
				| undefined;
			if (set) {
				observed = await runtime
					.conductor([campId], `hobo-release:${process.pid}`)
					.reconcileOnce(campId, {
						...ctx,
						signal: AbortSignal.timeout(5_000),
					});
			}
			await runtime.cd.rollouts.tick(ctx);
			await runtime.cd.verification.tick(ctx);
			const promotion = await runtime.cd.promotions.get(promotionId);
			const ours = observed && set && observed.setId === set.setId;
			return {
				state: PromotionState[promotion?.state ?? 0]
					? `PROMOTION_STATE_${PromotionState[promotion?.state ?? 0]}`
					: "PROMOTION_STATE_UNSPECIFIED",
				reasons: promotion?.reasons ?? [],
				...(ours
					? {
							observed: `RECONCILE_STATUS_${ReconcileStatus[observed?.status ?? 0]}`,
							observedReasons: observed?.reasons ?? [],
						}
					: undefined),
			};
		},
		close: () => runtime.close(),
	};
}

type ReleaseReport = {
	family: ReleaseFamily;
	freightId: string;
	alias: string;
	channels: Partial<Record<ReleaseChannel, ReleaseVerdict>>;
};

export function releaseReportPath(home: string, family: ReleaseFamily): string {
	return join(home, `release-freight-${family}.json`);
}

function readReport(
	home: string,
	family: ReleaseFamily,
): ReleaseReport | undefined {
	const path = releaseReportPath(home, family);
	if (!existsSync(path)) return undefined;
	// SAFETY: writeReport is the only writer of this file, in this module.
	return JSON.parse(readFileSync(path, "utf8")) as ReleaseReport;
}

function writeReport(home: string, report: ReleaseReport): void {
	writeFileSync(
		releaseReportPath(home, report.family),
		`${JSON.stringify(report, null, 2)}\n`,
	);
}

/**
 * Record one family's release Freight through `hobo deploy freight record`
 * and apply the release pipelines (`pipeline apply --file
 * release/hobo-release.delivery.ts`). `stored` bytes go into the HoBo artifact
 * store first (verified by digest); `registry` artifacts are verified by
 * `@hobo/cd` at their registry coordinate. Any refusal throws: nothing
 * unrecorded is published.
 */
export async function recordReleaseFreight(
	cd: ReleaseCd,
	input: {
		readonly family: ReleaseFamily;
		readonly source: ReleaseSource;
		readonly stored?:
			| readonly {
					name: string;
					kind: ArtifactKindName;
					mediaType: string;
					bytes: Uint8Array;
			  }[]
			| undefined;
		readonly registry?: readonly ReleaseArtifact[] | undefined;
		readonly labels?: Readonly<Record<string, string>> | undefined;
		/** Content blobs a listed artifact names by digest (a site tree's files). */
		readonly blobs?: readonly Uint8Array[] | undefined;
	},
): Promise<{ freightId: string; alias: string }> {
	const artifacts: ReleaseArtifact[] = [...(input.registry ?? [])];
	for (const item of input.stored ?? [])
		artifacts.push(await cd.store(item.bytes, item));
	for (const bytes of input.blobs ?? [])
		await cd.store(bytes, {
			name: `${releaseBindle(input.family)}.blob`,
			kind: "ARTIFACT_KIND_STATIC_ASSETS",
			mediaType: "application/octet-stream",
		});
	if (artifacts.length === 0)
		throw new Error(`release Freight for ${input.family} has no artifacts`);
	const declared = await cd.declaration(releaseDeclaration(input.family));
	const declaration = await cd.store(declared.bytes, {
		name: `${releaseBindle(input.family)}.declaration`,
		kind: "ARTIFACT_KIND_SOURCE_TREE",
		mediaType: "application/vnd.hobo.bindle+json",
	});
	if (declaration.digest !== declared.digest)
		throw new Error(
			`release declaration stored as ${declaration.digest}, not its canonical hash ${declared.digest}`,
		);
	const manifest = releaseFreightManifest({
		family: input.family,
		declarationHash: declared.digest,
		source: input.source,
		artifacts: [...artifacts, declaration],
		labels: input.labels,
	});
	const file = join(cd.home, `release-freight-${input.family}.manifest.json`);
	writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
	const recorded = await cd.run(["freight", "record"], { file });
	const freight = recorded.data?.freight;
	if (!recorded.ok || !freight?.freightId)
		throw new Error(
			`hobo deploy freight record refused ${input.family}: ${recorded.code} ${JSON.stringify(recorded.data?.reasons ?? [])}`,
		);
	const applied = await cd.run(["pipeline", "apply"], {
		file: RELEASE_DELIVERY_MODULE,
	});
	if (!applied.ok)
		throw new Error(
			`hobo deploy pipeline apply refused ${RELEASE_DELIVERY_MODULE}: ${codesOf(applied.data?.reasons).join(", ") || applied.code}`,
		);
	writeReport(cd.home, {
		family: input.family,
		freightId: freight.freightId,
		alias: freight.alias ?? "",
		channels: {},
	});
	return { freightId: freight.freightId, alias: freight.alias ?? "" };
}

/** How long and how often a promotion is driven before it reads as blocked. */
export const RELEASE_DRIVE = Object.freeze({ passes: 150, intervalMs: 2_000 });

/**
 * Promote recorded release Freight into one channel's Camp through `hobo
 * deploy promote` on the family's pipeline (`@hobo/cd` enforces candidate ->
 * stable lineage), then drive it until it qualifies, the realizer refuses, or
 * the passes run out (blocked: never read as qualified).
 */
export async function promoteReleaseFreight(
	cd: ReleaseCd,
	input: {
		readonly family: ReleaseFamily;
		readonly channel: ReleaseChannel;
		readonly freightId: string;
		readonly drive?: ReleaseCdSeams["drive"];
	},
): Promise<ReleaseVerdict> {
	const camp = releaseCampId(input.family, input.channel);
	const requested = await cd.run(["promote", input.freightId], {
		camp,
		pipeline: releaseBindle(input.family),
		node: input.channel,
		...(input.channel === "stable"
			? { "source-camp": releaseCampId(input.family, "candidate") }
			: undefined),
	});
	const promotionId = requested.data?.promotion?.promotionId ?? "";
	let verdict: ReleaseVerdict | undefined;
	if (!requested.ok || !promotionId) {
		const codes = codesOf(requested.data?.reasons);
		verdict = {
			outcome: "blocked",
			codes:
				codes.length > 0
					? codes
					: [requested.code ?? "release-promotion-refused"],
			message: requested.message ?? "",
		};
	} else {
		const drive = input.drive ?? RELEASE_DRIVE;
		for (let pass = 0; pass < drive.passes && !verdict; pass++) {
			verdict = classifyRelease(promotionId, await cd.drive(promotionId, camp));
			if (!verdict && pass + 1 < drive.passes) await delay(drive.intervalMs);
		}
		verdict ??= {
			outcome: "blocked",
			codes: ["release-promotion-pending"],
			message: `promotion ${promotionId} into ${camp} did not finish`,
			promotionId,
		};
	}
	const report = readReport(cd.home, input.family);
	if (report) {
		report.channels[input.channel] = verdict;
		writeReport(cd.home, report);
	}
	return verdict;
}

/** Print a verdict for humans (and the Actions summary); true unless blocked. */
export function announceVerdict(
	family: ReleaseFamily,
	channel: ReleaseChannel,
	freightId: string,
	verdict: ReleaseVerdict,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	const line = `release Freight ${family} ${freightId} -> ${releaseCampId(family, channel)}: ${verdict.outcome} (${verdict.codes.join(", ") || "none"})`;
	const allowed =
		verdict.outcome === "qualified" ||
		(verdict.outcome === "impedance" && RELEASE_IMPEDANCE_FAMILIES.has(family));
	if (!allowed) console.error(`::error::${line} ${verdict.message}`);
	else if (verdict.outcome === "impedance")
		console.log(
			`::warning::${line}: the ${family} resolver cannot realize this target (${verdict.message}); its existing publish step stays the publisher`,
		);
	else console.log(line);
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
	return allowed;
}

/**
 * Record one family and promote it into its candidate Camp, whose realizer
 * publishes it; throws unless it qualified (or, for an impedance family, the
 * resolver refused with a typed impedance code).
 */
export async function qualifyReleaseCandidate(input: {
	readonly home: string;
	readonly family: ReleaseFamily;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly stored?: Parameters<typeof recordReleaseFreight>[1]["stored"];
	readonly registry?: readonly ReleaseArtifact[];
	readonly labels?: Readonly<Record<string, string>>;
	readonly blobs?: readonly Uint8Array[];
	readonly seams?: ReleaseCdSeams;
}): Promise<{ freightId: string; verdict: ReleaseVerdict }> {
	const env = input.env ?? process.env;
	const cd = await openReleaseCd({
		home: input.home,
		env,
		...(input.seams ? { seams: input.seams } : undefined),
	});
	try {
		const { freightId } = await recordReleaseFreight(cd, {
			family: input.family,
			source: releaseSource(env),
			stored: input.stored,
			registry: input.registry,
			labels: input.labels,
			blobs: input.blobs,
		});
		const verdict = await promoteReleaseFreight(cd, {
			family: input.family,
			channel: "candidate",
			freightId,
			...(input.seams?.drive ? { drive: input.seams.drive } : undefined),
		});
		if (!announceVerdict(input.family, "candidate", freightId, verdict, env))
			throw new Error(
				`release Freight ${input.family} blocked: ${verdict.codes.join(", ")}`,
			);
		return { freightId, verdict };
	} finally {
		await cd.close();
	}
}

/**
 * Promote every family recorded under `home` to its stable Camp; false when
 * any is blocked. A family whose candidate verdict was `impedance` has no
 * qualified candidate to promote: it is reported, not promoted.
 */
export async function promoteReleaseStable(
	home: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
	seams: ReleaseCdSeams = {},
): Promise<boolean> {
	const families = RELEASE_FAMILIES.filter((f) => readReport(home, f));
	if (families.length === 0) {
		console.error(`::error::no release Freight recorded under ${home}`);
		return false;
	}
	const cd = await openReleaseCd({ home, env, seams });
	let ok = true;
	try {
		for (const family of families) {
			const report = readReport(home, family);
			const freightId = report?.freightId ?? "";
			const candidate = report?.channels.candidate;
			if (
				candidate?.outcome === "impedance" &&
				RELEASE_IMPEDANCE_FAMILIES.has(family)
			) {
				ok = announceVerdict(family, "stable", freightId, candidate, env) && ok;
				continue;
			}
			const verdict = await promoteReleaseFreight(cd, {
				family,
				channel: "stable",
				freightId,
				...(seams.drive ? { drive: seams.drive } : undefined),
			});
			ok = announceVerdict(family, "stable", freightId, verdict, env) && ok;
		}
	} finally {
		await cd.close();
	}
	return ok;
}

// ── The Pages site tree (`hobo.static-site-tree/v1`) ───────────────────────

/** One file of a published tree: its bytes go into the CD artifact store. */
export type SiteTreeFile = Readonly<{
	path: string;
	digest: string;
	size: number;
	bytes: Uint8Array;
}>;

/**
 * The tree index `@hobo/provider-github` realizes (sorted paths, each file's
 * sha256 and size) plus the file blobs. Its digest names the exact bytes the
 * site publishes; the realizer computes the git tree from it.
 */
export type SiteTree = Readonly<{
	digest: string;
	index: Uint8Array;
	files: readonly SiteTreeFile[];
}>;

const sha256 = (bytes: Uint8Array) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function siteTree(dir: string): SiteTree {
	const files: SiteTreeFile[] = [];
	const walk = (at: string) => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const full = join(at, entry.name);
			// A staging clone's git metadata is not part of what publishes.
			if (entry.isDirectory() && entry.name === ".git") continue;
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && !lstatSync(full).isSymbolicLink()) {
				const bytes = new Uint8Array(readFileSync(full));
				files.push({
					path: relative(dir, full).split(sep).join("/"),
					digest: sha256(bytes),
					size: bytes.byteLength,
					bytes,
				});
			}
		}
	};
	walk(dir);
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const index = new TextEncoder().encode(
		JSON.stringify({
			contract: "hobo.static-site-tree/v1",
			files: files.map((f) => ({
				path: f.path,
				digest: f.digest,
				size: f.size,
			})),
		}),
	);
	return { digest: sha256(index), index, files };
}
// ── GitHub Release ──────────────────────────────────────────────────────────

/** One API answer: the status, as it arrived. */
export type ReleaseApiRequest = (
	url: string,
	init: {
		readonly method: "GET" | "POST";
		readonly headers: Readonly<Record<string, string>>;
		readonly body?: string;
	},
) => Promise<{ readonly status: number; readonly text: string }>;

const requestOverHttp: ReleaseApiRequest = async (url, init) => {
	const response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(30_000),
	});
	return { status: response.status, text: await response.text() };
};

export async function ensureGitHubRelease(options: {
	readonly repository: string;
	readonly token: string;
	readonly tag: string;
	readonly prerelease: boolean;
	readonly apiUrl?: string | undefined;
	readonly request?: ReleaseApiRequest;
	readonly attempts?: number;
	readonly sleep?: (ms: number) => Promise<void>;
}): Promise<"exists" | "created"> {
	const api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/u, "");
	const request = options.request ?? requestOverHttp;
	const attempts = options.attempts ?? 3;
	const sleep = options.sleep ?? ((ms: number) => delay(ms));
	const headers = {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${options.token}`,
		"content-type": "application/json",
		"user-agent": "hobo-release-tag",
		"x-github-api-version": "2022-11-28",
	};
	const base = `${api}/repos/${options.repository}/releases`;
	let failure = "";
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const found = await request(
				`${base}/tags/${encodeURIComponent(options.tag)}`,
				{ method: "GET", headers },
			);
			if (found.status === 200) return "exists";
			if (found.status !== 404) {
				failure = `GET release: HTTP ${found.status}`;
			} else {
				const made = await request(base, {
					method: "POST",
					headers,
					body: JSON.stringify({
						tag_name: options.tag,
						name: options.tag,
						prerelease: options.prerelease,
						generate_release_notes: true,
					}),
				});
				if (made.status === 201) return "created";
				// Another run created it between the two calls.
				if (made.status === 422 && made.text.includes("already_exists")) {
					return "exists";
				}
				failure = `POST release: HTTP ${made.status} ${made.text.slice(0, 300)}`;
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		if (attempt < attempts) await sleep(2000 * attempt);
	}
	throw new Error(`GitHub Release ${options.tag}: ${failure}`);
}

function parseArgs(argv: readonly string[]) {
	let tag = "";
	let prerelease = false;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--tag") tag = argv[++i] ?? "";
		else if (arg === "--prerelease") prerelease = true;
	}
	if (!tag.trim()) {
		console.error(
			"usage: create-github-release.mts --tag <tag> [--prerelease]",
		);
		process.exit(2);
	}
	return { tag: tag.trim(), prerelease };
}

async function main(): Promise<void> {
	if (process.argv[2] === "promote-stable") {
		const homes: string[] = [];
		for (let i = 3; i < process.argv.length; i++) {
			if (process.argv[i] === "--freight-home")
				homes.push(process.argv[++i] ?? "");
		}
		if (homes.length === 0 || homes.some((h) => !h.trim())) {
			console.error(
				"usage: create-github-release.mts promote-stable --freight-home <dir> [--freight-home <dir>]",
			);
			process.exit(2);
		}
		let ok = true;
		for (const home of homes) ok = (await promoteReleaseStable(home)) && ok;
		if (!ok) process.exit(1);
		return;
	}
	const { tag, prerelease } = parseArgs(process.argv);
	const repository = process.env.GITHUB_REPOSITORY?.trim() ?? "";
	const token = process.env.GITHUB_TOKEN?.trim() ?? "";
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !token) {
		throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
	}
	const outcome = await ensureGitHubRelease({
		repository,
		token,
		tag,
		prerelease,
		apiUrl: process.env.GITHUB_API_URL,
	});
	console.log(
		outcome === "exists"
			? `GitHub Release ${tag} already exists`
			: `created GitHub Release ${tag}${prerelease ? " (prerelease)" : ""}`,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
