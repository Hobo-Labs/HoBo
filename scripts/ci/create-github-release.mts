#!/usr/bin/env node
/**
 * HoBo releases itself through HoBo CD, then creates the GitHub Release.
 *
 * Release Freight: every release artifact family (npm tarballs, GHCR images by
 * digest, the Pages bundle) is recorded as Freight and promoted
 * `hobo-release/candidate` -> `hobo-release/stable` through the `hobo deploy`
 * composition of `@hobo/cd` (`openDefaultCdHost` + `runCdDeploySubcommand`
 * from the built `@hobo/hobo`, the same code the `hobo deploy` verb runs).
 * Publication steps run only on a `qualified` or `gap` verdict; `gap` means
 * `@hobo/cd` refused with a typed reason for missing topology or realizer
 * (RELEASE_GAP_CODES), which is printed and never read as qualification.
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

export type ReleaseFamily = "npm" | "oci" | "pages";
export type ReleaseChannel = "candidate" | "stable";

export const RELEASE_FAMILIES: readonly ReleaseFamily[] = [
	"npm",
	"oci",
	"pages",
];
export const RELEASE_YARD = "hobo-release";

/** `<yard>/<camp>`: the Camp each release channel promotes into. */
export function releaseCampId(channel: ReleaseChannel): string {
	return `${RELEASE_YARD}/${channel}`;
}

export function releaseBindle(family: ReleaseFamily): string {
	return `hobo-release-${family}`;
}

/**
 * Typed refusals `@hobo/cd` gives when the release Camps have no topology or
 * realizer in the `hobo deploy` composition (no Yard declares them; no realizer
 * publishes to npm, GHCR or GitHub Pages). Only these make a `gap` verdict.
 */
export const RELEASE_GAP_CODES: ReadonlySet<string> = new Set([
	"pipeline-unknown-camp",
	"promotion-resolve-failed",
	"planning-camp-unknown",
	"compose-realizer-missing",
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

/** The delivery record `hobo deploy pipeline apply --file` takes for one family. */
export function releasePipelineModule(family: ReleaseFamily) {
	return {
		pipelines: [
			{
				name: releaseBindle(family),
				bindle: releaseBindle(family),
				nodes: [
					{
						name: "candidate",
						campIds: [releaseCampId("candidate")],
						fromSources: ["origin:manifest"],
					},
					{
						name: "stable",
						campIds: [releaseCampId("stable")],
						fromNodes: ["candidate"],
					},
				],
			},
		],
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
		readonly camps?: readonly {
			readonly promotions?: readonly CdPromotion[];
		}[];
	};
};

export type ReleaseVerdict = Readonly<{
	outcome: "qualified" | "gap" | "blocked";
	codes: readonly string[];
	message: string;
	promotionId?: string;
	lineage?: "pipeline" | "candidate-journaled";
}>;

const gapOnly = (codes: readonly string[]) =>
	codes.length > 0 && codes.every((code) => RELEASE_GAP_CODES.has(code));

/** Read one `hobo deploy promote` result as a release verdict (fail closed). */
export function classifyPromotion(result: CdResult): ReleaseVerdict {
	const promotion = result.data?.promotion;
	if (!result.ok || !promotion) {
		const codes = (result.data?.reasons ?? []).map((r) => r.code ?? "");
		const all =
			codes.length > 0 ? codes : [result.code ?? "release-promotion-refused"];
		return {
			outcome: gapOnly(all) ? "gap" : "blocked",
			codes: all,
			message: result.message ?? "",
		};
	}
	const codes = (promotion.reasons ?? []).map((r) => r.code ?? "");
	const base = { codes, promotionId: promotion.promotionId ?? "" };
	if (promotion.state === "PROMOTION_STATE_PROMOTED")
		return { ...base, outcome: "qualified", message: "promoted and qualified" };
	if (promotion.state === "PROMOTION_STATE_REJECTED" && gapOnly(codes))
		return {
			...base,
			outcome: "gap",
			message: (promotion.reasons ?? []).map((r) => r.message).join("; "),
		};
	return {
		...base,
		outcome: "blocked",
		codes: codes.length > 0 ? codes : ["release-promotion-pending"],
		message: `promotion ${promotion.promotionId ?? ""} is ${promotion.state ?? "unknown"}`,
	};
}

/** The `hobo deploy` composition opened on one HOBO_HOME. */
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
 * Open the `hobo deploy` composition (SQLite journal and filesystem artifact
 * store under `home`). The `hobo` verb's shell parser does not yet pass
 * `--file`/`--camp` to `deploy`, so this calls the verb's own host and
 * dispatcher directly; nothing else is composed here.
 */
export async function openReleaseCd(options: {
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<ReleaseCd> {
	if (!existsSync(HOBO_CLI_DIST))
		throw new Error(
			`release Freight needs the built hobo CLI (${HOBO_CLI_DIST}); run pnpm exec turbo run build --filter=@hobo/hobo...`,
		);
	const hobo = await import(pathToFileURL(HOBO_CLI_DIST).href);
	const env = {
		...options.env,
		HOBO_HOME: options.home,
		HOBO_USER: options.env.HOBO_USER || "hobo-release",
	};
	const opened = await hobo.openDefaultCdHost({
		simulate: false,
		cwd: options.home,
		env,
		home: options.home,
	});
	if (!opened.ok)
		throw new Error(
			`hobo deploy could not open CD: ${JSON.stringify(opened.reasons)}`,
		);
	const host = opened.value.host;
	return {
		home: options.home,
		run: async (args, flags = {}) =>
			hobo.runCdDeploySubcommand(host, args, { ...flags, format: "json" }),
		async store(bytes, meta) {
			const kind = ARTIFACT_KIND[meta.kind];
			const ref = await host.cd.artifacts.put(
				bytes,
				{ name: meta.name, kind, mediaType: meta.mediaType },
				host.ctx,
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
		close: () => opened.value.close(),
	};
}

type ReleaseReport = {
	family: ReleaseFamily;
	freightId: string;
	alias: string;
	pipeline: { applied: boolean; codes: readonly string[] };
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
 * Record one family's release Freight through `hobo deploy freight record`.
 * `stored` bytes go into the HoBo artifact store first (verified by digest);
 * `registry` artifacts are verified by `@hobo/cd` at their registry coordinate.
 * Any refusal throws: nothing unrecorded is published.
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
	},
): Promise<{ freightId: string; alias: string }> {
	const artifacts: ReleaseArtifact[] = [...(input.registry ?? [])];
	for (const item of input.stored ?? [])
		artifacts.push(await cd.store(item.bytes, item));
	if (artifacts.length === 0)
		throw new Error(`release Freight for ${input.family} has no artifacts`);
	// The release declaration: which artifacts this release is, by digest.
	const declaration = await cd.store(
		new TextEncoder().encode(
			JSON.stringify({
				schema: "hobo.release-declaration/v1",
				family: input.family,
				source: input.source,
				artifacts: artifacts
					.map((a) => ({ name: a.name, digest: a.digest }))
					.sort((a, b) => a.name.localeCompare(b.name)),
			}),
		),
		{
			name: `${releaseBindle(input.family)}.declaration`,
			kind: "ARTIFACT_KIND_SOURCE_TREE",
			mediaType: "application/vnd.hobo.release-declaration+json",
		},
	);
	const manifest = releaseFreightManifest({
		family: input.family,
		declarationHash: declaration.digest,
		source: input.source,
		artifacts,
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
	const pipelineFile = join(cd.home, `release-pipeline-${input.family}.json`);
	writeFileSync(
		pipelineFile,
		JSON.stringify(releasePipelineModule(input.family)),
	);
	const applied = await cd.run(["pipeline", "apply"], { file: pipelineFile });
	const pipelineCodes = applied.ok
		? []
		: (applied.data?.reasons ?? []).map((r) => r.code ?? "");
	if (!applied.ok && !gapOnly(pipelineCodes))
		throw new Error(
			`hobo deploy pipeline apply refused ${releaseBindle(input.family)}: ${pipelineCodes.join(", ")}`,
		);
	writeReport(cd.home, {
		family: input.family,
		freightId: freight.freightId,
		alias: freight.alias ?? "",
		pipeline: { applied: applied.ok, codes: pipelineCodes },
		channels: {},
	});
	return { freightId: freight.freightId, alias: freight.alias ?? "" };
}

/**
 * Promote recorded release Freight into one channel's Camp through
 * `hobo deploy promote`. With the release pipeline applied, `@hobo/cd`
 * enforces candidate -> stable lineage itself; without it (the topology gap),
 * stable also requires a journaled candidate promotion of the same Freight.
 */
export async function promoteReleaseFreight(
	cd: ReleaseCd,
	input: {
		readonly family: ReleaseFamily;
		readonly channel: ReleaseChannel;
		readonly freightId: string;
	},
): Promise<ReleaseVerdict> {
	const report = readReport(cd.home, input.family);
	const pipelined = report?.pipeline.applied === true;
	const shown = await cd.run(["freight", "show", input.freightId]);
	let verdict: ReleaseVerdict;
	if (!shown.ok || shown.data?.usable !== true) {
		verdict = {
			outcome: "blocked",
			codes: ["release-freight-unusable"],
			message: `Freight ${input.freightId} is missing, yanked or retired`,
		};
	} else if (input.channel === "stable" && !pipelined) {
		const candidate = await cd.run(["status"], {
			camp: releaseCampId("candidate"),
		});
		const journaled = (candidate.data?.camps ?? [])
			.flatMap((c) => c.promotions ?? [])
			.some(
				(p) =>
					p.freightId === input.freightId &&
					classifyPromotion({ ok: true, data: { promotion: p } }).outcome !==
						"blocked",
			);
		verdict = journaled
			? {
					...classifyPromotion(
						await cd.run(["promote", input.freightId], {
							camp: releaseCampId("stable"),
						}),
					),
					lineage: "candidate-journaled",
				}
			: {
					outcome: "blocked",
					codes: ["release-lineage-missing"],
					message: `Freight ${input.freightId} has no candidate promotion in this journal`,
				};
	} else {
		const camp = releaseCampId(input.channel);
		const flags = pipelined
			? { camp, pipeline: releaseBindle(input.family), node: input.channel }
			: { camp };
		verdict = classifyPromotion(
			await cd.run(["promote", input.freightId], flags),
		);
		if (pipelined) verdict = { ...verdict, lineage: "pipeline" };
	}
	if (report) {
		report.channels[input.channel] = verdict;
		writeReport(cd.home, report);
	}
	return verdict;
}

/** Print a verdict for humans (and the Actions summary); true when publishing may proceed. */
export function announceVerdict(
	family: ReleaseFamily,
	channel: ReleaseChannel,
	freightId: string,
	verdict: ReleaseVerdict,
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	const line = `release Freight ${family} ${freightId} -> ${releaseCampId(channel)}: ${verdict.outcome} (${verdict.codes.join(", ") || "none"})`;
	if (verdict.outcome === "blocked")
		console.error(`::error::${line} ${verdict.message}`);
	else if (verdict.outcome === "gap")
		console.log(
			`::warning::${line}: @hobo/cd has no realizer for this target; publication stays the existing step`,
		);
	else console.log(line);
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
	return verdict.outcome !== "blocked";
}

/** Record one family and promote it into the candidate channel; throws when blocked. */
export async function qualifyReleaseCandidate(input: {
	readonly home: string;
	readonly family: ReleaseFamily;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly stored?: Parameters<typeof recordReleaseFreight>[1]["stored"];
	readonly registry?: readonly ReleaseArtifact[];
	readonly labels?: Readonly<Record<string, string>>;
}): Promise<{ freightId: string; verdict: ReleaseVerdict }> {
	const env = input.env ?? process.env;
	const cd = await openReleaseCd({ home: input.home, env });
	try {
		const { freightId } = await recordReleaseFreight(cd, {
			family: input.family,
			source: releaseSource(env),
			stored: input.stored,
			registry: input.registry,
			labels: input.labels,
		});
		const verdict = await promoteReleaseFreight(cd, {
			family: input.family,
			channel: "candidate",
			freightId,
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

/** Promote every family recorded under `home` to stable; false when any is blocked. */
export async function promoteReleaseStable(
	home: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
	const families = RELEASE_FAMILIES.filter((f) => readReport(home, f));
	if (families.length === 0) {
		console.error(`::error::no release Freight recorded under ${home}`);
		return false;
	}
	const cd = await openReleaseCd({ home, env });
	let ok = true;
	try {
		for (const family of families) {
			const freightId = readReport(home, family)?.freightId ?? "";
			const verdict = await promoteReleaseFreight(cd, {
				family,
				channel: "stable",
				freightId,
			});
			ok = announceVerdict(family, "stable", freightId, verdict, env) && ok;
		}
	} finally {
		await cd.close();
	}
	return ok;
}

/**
 * A deterministic index of a published tree (sorted paths with each file's
 * sha256). Its digest names the exact bytes a static site publishes.
 */
export type SiteTreeIndex = Readonly<{ digest: string; bytes: Uint8Array }>;

export function siteTreeIndex(dir: string): SiteTreeIndex {
	const files: { path: string; sha256: string; size: number }[] = [];
	const walk = (at: string) => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const full = join(at, entry.name);
			// A staging clone's git metadata is not part of what publishes.
			if (entry.isDirectory() && entry.name === ".git" && at === dir) continue;
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) {
				const bytes = readFileSync(full);
				files.push({
					path: relative(dir, full).split(sep).join("/"),
					sha256: createHash("sha256").update(bytes).digest("hex"),
					size: bytes.byteLength,
				});
			}
		}
	};
	walk(dir);
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const bytes = new TextEncoder().encode(
		JSON.stringify({ schema: "hobo.release-tree/v1", files }),
	);
	return {
		digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		bytes,
	};
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
