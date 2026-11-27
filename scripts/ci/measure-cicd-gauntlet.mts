import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

type Run = {
	id: number;
	head_sha: string;
	status: string;
	conclusion: string | null;
	created_at: string;
	updated_at: string;
	run_attempt?: number;
	html_url?: string;
};

type Job = {
	name: string;
	status: string;
	conclusion: string | null;
	started_at: string | null;
	completed_at: string | null;
};

type RunEvidence = {
	run: Run;
	jobs: { total_count: number; jobs: Job[] };
	event?: { action?: string; workflow_run?: Run };
};

type CacheEvidence = { state: "warm" | "cold" | "unknown"; evidence: string[] };

type Requirement = {
	deployable: string;
	jobs: { stage: "ci" | "cd"; name: string }[];
	publicOci?: {
		required: boolean;
		reason?: string;
		digest?: string;
		manifest?: string;
		manifestStatus?: number;
		anonymous?: boolean;
		manifests?: {
			digest: string;
			manifest: string;
			status: number;
			anonymous: boolean;
		}[];
		blobs?: {
			digest: string;
			actualDigest: string;
			actualSize: number;
			status: number;
			anonymous: boolean;
		}[];
		evidence?: string[];
	};
};

export type GauntletInput = {
	ci: RunEvidence;
	cd: RunEvidence[];
	requirements: Requirement[];
	cache: CacheEvidence & { deployables?: Record<string, CacheEvidence> };
};

function timestamp(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

const ociDigest = /^sha256:[a-f0-9]{64}$/u;
const imageMediaTypes = new Set([
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
]);
const indexMediaTypes = new Set([
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
]);
const descriptorSchema = z.object({
	digest: z.string().regex(ociDigest),
	size: z.number().int().nonnegative().safe(),
	mediaType: z.string().min(1).optional(),
	annotations: z.record(z.string(), z.string()).optional(),
});
const imageSchema = z.object({
	schemaVersion: z.literal(2),
	mediaType: z.string().min(1).optional(),
	artifactType: z.string().optional(),
	config: descriptorSchema,
	layers: z.array(descriptorSchema).max(1024),
});
const indexSchema = z.object({
	schemaVersion: z.literal(2),
	mediaType: z.string().min(1).optional(),
	manifests: z.array(descriptorSchema).min(1).max(256),
});

function anonymousOciAvailable(
	oci: NonNullable<Requirement["publicOci"]>,
): boolean {
	if (
		oci.required !== true ||
		oci.anonymous !== true ||
		oci.manifestStatus !== 200 ||
		!oci.manifest ||
		!oci.digest ||
		!ociDigest.test(oci.digest) ||
		!Array.isArray(oci.evidence) ||
		!Array.isArray(oci.blobs) ||
		(oci.manifests !== undefined && !Array.isArray(oci.manifests))
	)
		return false;
	const rootManifest = z
		.string()
		.min(1)
		.max(4 * 1024 * 1024)
		.safeParse(oci.manifest);
	const rootDigest = z.string().regex(ociDigest).safeParse(oci.digest);
	const sources = z.array(z.string()).max(128).safeParse(oci.evidence);
	if (
		!rootManifest.success ||
		!rootDigest.success ||
		!sources.success ||
		!sources.data.some((source) => source.trim() !== "")
	)
		return false;
	const manifestEvidence = z
		.array(
			z.object({
				digest: z.string().regex(ociDigest),
				manifest: z.string().max(4 * 1024 * 1024),
				status: z.number(),
				anonymous: z.boolean(),
			}),
		)
		.max(256)
		.safeParse(oci.manifests ?? []);
	const blobEvidence = z
		.array(
			z.object({
				digest: z.string().regex(ociDigest),
				actualDigest: z.string().regex(ociDigest),
				actualSize: z.number().int().nonnegative().safe(),
				status: z.number(),
				anonymous: z.boolean(),
			}),
		)
		.max(4096)
		.safeParse(oci.blobs);
	if (!manifestEvidence.success || !blobEvidence.success) return false;
	const manifests = new Map<string, (typeof manifestEvidence.data)[number]>();
	const blobs = new Map<string, (typeof blobEvidence.data)[number]>();
	for (const item of manifestEvidence.data) {
		if (manifests.has(item.digest)) return false;
		manifests.set(item.digest, item);
	}
	for (const blob of blobEvidence.data) {
		if (blobs.has(blob.digest)) return false;
		blobs.set(blob.digest, blob);
	}
	const active = new Set<string>();
	let visited = 0;
	let runnable = 0;
	const visit = (
		body: string,
		digest: string,
		expectedSize: number | undefined,
		expectedType: string | undefined,
		depth: number,
		attestation: boolean,
	): boolean => {
		if (depth > 16 || ++visited > 256 || active.has(digest)) return false;
		const bytes = Buffer.from(body, "utf8");
		if (
			bytes.length > 4 * 1024 * 1024 ||
			(expectedSize !== undefined && bytes.length !== expectedSize) ||
			`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest
		)
			return false;
		try {
			const document: unknown = JSON.parse(body);
			const fields = z.record(z.string(), z.unknown()).safeParse(document);
			if (!fields.success) return false;
			if (
				Object.hasOwn(fields.data, "manifests") &&
				(Object.hasOwn(fields.data, "config") ||
					Object.hasOwn(fields.data, "layers"))
			)
				return false;
			const image = imageSchema.safeParse(document);
			const index = indexSchema.safeParse(document);
			if (image.success === index.success) return false;
			const mediaType = image.success
				? image.data.mediaType
				: index.success
					? index.data.mediaType
					: undefined;
			if (expectedType && mediaType && expectedType !== mediaType) return false;
			const actualType = mediaType ?? expectedType;
			if (
				(actualType && image.success && !imageMediaTypes.has(actualType)) ||
				(actualType && index.success && !indexMediaTypes.has(actualType))
			)
				return false;
			active.add(digest);
			if (index.success) {
				for (const child of index.data.manifests) {
					if (
						!child.mediaType ||
						(!imageMediaTypes.has(child.mediaType) &&
							!indexMediaTypes.has(child.mediaType))
					)
						return false;
					const evidence = manifests.get(child.digest);
					if (
						!evidence ||
						evidence.status !== 200 ||
						evidence.anonymous !== true ||
						!visit(
							evidence.manifest,
							child.digest,
							child.size,
							child.mediaType,
							depth + 1,
							attestation ||
								child.annotations?.["vnd.docker.reference.type"] ===
									"attestation-manifest",
						)
					)
						return false;
				}
			} else if (image.success) {
				if (!attestation && !image.data.artifactType) runnable++;
				for (const descriptor of [image.data.config, ...image.data.layers]) {
					const evidence = blobs.get(descriptor.digest);
					if (
						!evidence ||
						evidence.status !== 200 ||
						evidence.anonymous !== true ||
						evidence.actualDigest !== descriptor.digest ||
						evidence.actualSize !== descriptor.size
					)
						return false;
				}
			}
			active.delete(digest);
			return true;
		} catch {
			return false;
		}
	};
	return (
		visit(rootManifest.data, rootDigest.data, undefined, undefined, 0, false) &&
		runnable > 0
	);
}

export function measureGauntlet(input: GauntletInput) {
	const errors: string[] = [];
	const warnings: string[] = [];
	const ci = input.ci;
	const runs = [ci, ...(input.cd ?? [])];
	if (!ci?.run || !Array.isArray(input.cd) || input.cd.length === 0) {
		throw new Error("CI and at least one CD run are required");
	}
	if (!Array.isArray(input.requirements) || input.requirements.length === 0) {
		throw new Error("At least one deployable requirement is required");
	}
	if (
		!input.cache ||
		!Array.isArray(input.cache.evidence) ||
		!["warm", "cold", "unknown"].includes(input.cache.state)
	) {
		throw new Error("Cache state and evidence are required");
	}
	if (!/^[0-9a-f]{40}$/i.test(ci.run.head_sha))
		errors.push("CI head SHA is missing or invalid");
	if (
		!Number.isSafeInteger(ci.run.id) ||
		ci.run.id <= 0 ||
		!Number.isSafeInteger(ci.run.run_attempt) ||
		(ci.run.run_attempt ?? 0) <= 0
	)
		errors.push("CI run ID or attempt is missing");
	for (const [index, entry] of runs.entries()) {
		const label = index === 0 ? "CI" : `CD ${index}`;
		const run = entry.run;
		if (!run || run.status !== "completed" || run.conclusion !== "success") {
			errors.push(`${label} workflow is not completed successfully`);
		}
		if (!run || run.head_sha !== ci.run.head_sha)
			errors.push(`${label} head SHA differs from CI`);
		if (
			!entry.jobs ||
			!Array.isArray(entry.jobs.jobs) ||
			entry.jobs.jobs.length !== entry.jobs.total_count
		) {
			errors.push(`${label} jobs are missing or paginated incompletely`);
		}
		const created = timestamp(run?.created_at);
		const updated = timestamp(run?.updated_at);
		if (created === undefined || updated === undefined || updated < created) {
			errors.push(`${label} workflow timestamps are invalid`);
		}
		if (index > 0) {
			const trigger = entry.event?.workflow_run;
			if (
				entry.event?.action !== "completed" ||
				trigger?.id !== ci.run.id ||
				trigger?.head_sha !== ci.run.head_sha ||
				trigger?.run_attempt !== ci.run.run_attempt
			) {
				errors.push(
					`${label} has no matching completed CI workflow_run event evidence`,
				);
			}
			const ciCreated = timestamp(ci.run.created_at);
			if (
				created !== undefined &&
				ciCreated !== undefined &&
				created < ciCreated
			) {
				errors.push(`${label} was created before CI`);
			}
			const ciFinished = timestamp(ci.run.updated_at);
			if (
				created !== undefined &&
				ciFinished !== undefined &&
				created < ciFinished
			) {
				errors.push(`${label} was created before the triggering CI completed`);
			}
		}
	}
	const deployables = input.requirements.map((requirement) => {
		const failures: string[] = [];
		if (
			!requirement.deployable ||
			!Array.isArray(requirement.jobs) ||
			requirement.jobs.length === 0
		) {
			failures.push("No required jobs specified");
		} else {
			if (!requirement.jobs.some((job) => job.stage === "ci")) {
				failures.push("No required CI job specified");
			}
			if (!requirement.jobs.some((job) => job.stage === "cd")) {
				failures.push("No required CD job specified");
			}
			for (const check of requirement.jobs) {
				if (!check.name || !["ci", "cd"].includes(check.stage)) {
					failures.push("Invalid job requirement");
					continue;
				}
				const targets = check.stage === "ci" ? [ci] : input.cd;
				const matches = targets
					.flatMap((target) => target.jobs?.jobs ?? [])
					.filter((job) => job.name === check.name);
				if (matches.length === 0)
					failures.push(`Missing ${check.stage} job: ${check.name}`);
				for (const job of matches) {
					const jobStarted = timestamp(job.started_at);
					const jobCompleted = timestamp(job.completed_at);
					if (
						jobStarted === undefined ||
						jobCompleted === undefined ||
						jobCompleted < jobStarted
					) {
						failures.push(
							`Invalid timestamps for ${check.stage} job: ${job.name}`,
						);
					}
					if (job.status !== "completed" || job.conclusion !== "success") {
						failures.push(
							`Unsuccessful ${check.stage} job: ${job.name} (${job.conclusion ?? job.status})`,
						);
					}
				}
			}
		}
		const cache = input.cache.deployables?.[requirement.deployable];
		if (
			cache?.state !== "warm" ||
			!cache.evidence?.some((value) => value.trim() !== "")
		) {
			failures.push("Warm-cache evidence for this deployable is missing");
		}
		const oci = requirement.publicOci;
		let publicOciStatus = "unknown";
		if (oci?.required === false && oci.reason?.trim()) {
			publicOciStatus = "not applicable";
		} else if (oci && anonymousOciAvailable(oci)) {
			publicOciStatus = "available according to supplied anonymous probe";
		} else {
			failures.push(
				"Anonymous OCI digest and all-blob availability evidence is missing",
			);
		}
		if (failures.length)
			errors.push(
				`Deployable ${requirement.deployable || "(unnamed)"} is not verified`,
			);
		return {
			name: requirement.deployable,
			publicOciStatus,
			verified: failures.length === 0,
			failures,
		};
	});
	const created = timestamp(ci.run.created_at);
	const completed = runs
		.map((entry) => timestamp(entry.run?.updated_at))
		.filter((value): value is number => value !== undefined);
	const jobEnds = runs
		.flatMap((entry) => entry.jobs?.jobs ?? [])
		.filter((job) => job.conclusion !== "skipped")
		.map((job) => timestamp(job.completed_at))
		.filter((value): value is number => value !== undefined);
	const end =
		completed.length === runs.length
			? Math.max(...completed, ...jobEnds)
			: undefined;
	const durationSeconds =
		created !== undefined && end !== undefined && end >= created
			? (end - created) / 1000
			: null;
	if (durationSeconds === null)
		errors.push("End-to-end duration cannot be established");
	if (durationSeconds !== null && durationSeconds >= 600)
		errors.push("CI and CD took at least 600 seconds");
	if (
		input.cache.state !== "warm" ||
		!input.cache.evidence.some((value) => value.trim() !== "")
	) {
		errors.push("Warm-cache evidence is missing");
	}
	const queue = runs.map((entry, index) => {
		const start = timestamp(entry.run?.created_at);
		const firstJob = Math.min(
			...(entry.jobs?.jobs ?? [])
				.filter((job) => job.conclusion !== "skipped")
				.map((job) => timestamp(job.started_at))
				.filter((value): value is number => value !== undefined),
		);
		return {
			stage: index === 0 ? "ci" : "cd",
			runId: entry.run?.id,
			beforeFirstJobSeconds:
				start !== undefined && Number.isFinite(firstJob) && firstJob >= start
					? (firstJob - start) / 1000
					: null,
		};
	});
	warnings.push(
		"Registry and cache evidence is caller-supplied; external deployment health is not independently checked",
	);
	return {
		sha: ci.run.head_sha,
		ciRun: ci.run.html_url ?? ci.run.id,
		cdRuns: input.cd.map((entry) => entry.run.html_url ?? entry.run.id),
		durationSeconds,
		limitSeconds: 600,
		queue,
		cache: input.cache,
		deployables,
		errors,
		warnings,
		passed: errors.length === 0,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const file = process.argv[2];
		if (!file || process.argv.length !== 3)
			throw new Error(
				"Usage: node scripts/ci/measure-cicd-gauntlet.mts evidence.json",
			);
		const input: GauntletInput = JSON.parse(readFileSync(file, "utf8"));
		const eventPath = process.env.GITHUB_EVENT_PATH;
		const currentRunId = Number(process.env.GITHUB_RUN_ID);
		const currentCd = input.cd?.find((entry) => entry.run.id === currentRunId);
		if (eventPath && currentCd) {
			try {
				currentCd.event = JSON.parse(readFileSync(eventPath, "utf8"));
			} catch {
				throw new Error("Cannot read the current workflow event");
			}
		}
		const result = measureGauntlet(input);
		console.log(JSON.stringify(result, null, 2));
		if (!result.passed) process.exitCode = 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
