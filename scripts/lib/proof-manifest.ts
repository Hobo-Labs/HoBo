import { z } from "zod";

export const EXPERIENCE_TYPES = ["dx", "ux", "cx", "ax", "api"] as const;
export const PROOF_LAYERS = ["technical", "epic", "exp", "project"] as const;

export type ExperienceType = (typeof EXPERIENCE_TYPES)[number];
export type ProofLayer = (typeof PROOF_LAYERS)[number];

const relPath = z
	.string()
	.regex(
		/^[^/\\][^\\]*$/u,
		"package-relative path (no leading slash, no backslashes)",
	);
const repoPath = z.string().regex(/^[^/\\][^\\]*$/u, "repo-relative path");

export const proofManifestSchema = z
	.object({
		layer: z.enum(PROOF_LAYERS),
		slug: z.string().regex(/^[a-z0-9-]+$/u),
		experienceType: z.enum(EXPERIENCE_TYPES).optional(),
		title: z.string().min(1),
		linear: z
			.string()
			.regex(/^HOBO-\d+$/u)
			.optional(),
		references: z
			.object({
				technicalProofs: z.array(repoPath).default([]),
				epicProofs: z.array(repoPath).default([]),
				expProofs: z.array(repoPath).default([]),
			})
			.default({
				technicalProofs: [],
				epicProofs: [],
				expProofs: [],
			}),
		artifacts: z
			.object({
				examples: relPath.optional(),
				notebook: relPath.optional(),
				features: relPath.optional(),
				bench: relPath.optional(),
				diagrams: z.array(relPath).default([]),
				assets: relPath.optional(),
			})
			.default({ diagrams: [] }),
		waivers: z
			.array(
				z.object({
					requirement: z.enum([
						"examples",
						"notebook",
						"features",
						"bench",
						"diagrams",
						"assets",
						"cascade",
					]),
					reason: z.string().min(10),
				}),
			)
			.default([]),
	})
	.superRefine((manifest, ctx) => {
		if (manifest.layer === "exp" && !manifest.experienceType) {
			ctx.addIssue({
				code: "custom",
				path: ["experienceType"],
				message: "experienceType is required for exp-layer proofs",
			});
		}
		if (manifest.layer !== "exp" && manifest.experienceType) {
			ctx.addIssue({
				code: "custom",
				path: ["experienceType"],
				message: "experienceType is only valid for exp-layer proofs",
			});
		}
	});

export type ProofManifest = z.infer<typeof proofManifestSchema>;

export function workspaceForDraftFile(file: string): string | undefined {
	const normalized = file.replaceAll("\\", "/");
	const flat = normalized.match(
		/^(src\/draft\/(?:technical-proofs|epic-proofs|projects)\/[^/_][^/]*)\//u,
	);
	if (flat) return flat[1];
	const exp = normalized.match(
		/^(src\/draft\/exp-proofs\/(?:dx|ux|cx|ax|api)\/[^/_][^/]*)\//u,
	);
	return exp ? exp[1] : undefined;
}

export function layerForWorkspace(workspace: string): ProofLayer | undefined {
	if (workspace.startsWith("src/draft/technical-proofs/")) return "technical";
	if (workspace.startsWith("src/draft/epic-proofs/")) return "epic";
	if (workspace.startsWith("src/draft/exp-proofs/")) return "exp";
	if (workspace.startsWith("src/draft/projects/")) return "project";
	return undefined;
}

export function experienceTypeForWorkspace(
	workspace: string,
): ExperienceType | undefined {
	const match = workspace.match(
		/^src\/draft\/exp-proofs\/(dx|ux|cx|ax|api)\//u,
	);
	return match ? (match[1] as ExperienceType) : undefined;
}
