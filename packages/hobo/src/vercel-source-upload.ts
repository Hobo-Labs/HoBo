/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- SAFETY: this provider boundary validates untrusted deployment and missing-file responses before use. */
import { createHash } from "node:crypto";
import { readBoundedJsonResponse } from "./bounded-json-response.js";
import type { PinnedGitSource } from "./pinned-git-source.js";

export class VercelSourceDeploymentError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "VercelSourceDeploymentError";
	}
}

type SourceDeployment = Readonly<{ id: string; url: string }>;

const RELAY_RUNTIME_ENV_KEYS = [
	"HOBO_CI_CONFIG_SERVICE",
	"INFISICAL_SITE_URL",
	"INFISICAL_PROJECT_ID",
	"INFISICAL_IDENTITY_ID",
	"INFISICAL_ENVIRONMENT",
	"INFISICAL_SECRET_PATH",
] as const;

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function deployVercelSource(input: {
	readonly token: string;
	readonly teamId: string;
	readonly project: string;
	readonly name: string;
	readonly repository: string;
	readonly ref: string;
	readonly rootDirectory: string;
	readonly source: PinnedGitSource;
	readonly target: "preview" | "production";
	readonly runtimeEnvironment?: Readonly<Record<string, string>>;
	readonly buildSettings?: Readonly<{
		installCommand: string;
		buildCommand: string;
	}>;
	readonly fetch?: typeof fetch;
	readonly deadline?: number;
	readonly signal?: AbortSignal;
	readonly sleep?: (ms: number) => Promise<void>;
}): Promise<SourceDeployment> {
	if (
		!/^[!-~]{8,4096}$/u.test(input.token) ||
		!/^team_[A-Za-z0-9]+$/u.test(input.teamId) ||
		!/^(?:prj_[A-Za-z0-9]+|[A-Za-z0-9][A-Za-z0-9-]{0,99})$/u.test(
			input.project,
		) ||
		!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u.test(input.name) ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) ||
		!/^[A-Za-z0-9_./-]+$/u.test(input.ref) ||
		input.ref.includes("..") ||
		!/^[A-Za-z0-9_./-]+$/u.test(input.rootDirectory) ||
		input.rootDirectory.includes("..") ||
		!/^[0-9a-f]{40}$/u.test(input.source.commit) ||
		input.source.files.length === 0 ||
		(input.deadline !== undefined && !Number.isSafeInteger(input.deadline))
	)
		throw new VercelSourceDeploymentError(
			"invalid-input",
			"The Vercel source deployment input is invalid.",
		);

	if (
		input.runtimeEnvironment !== undefined &&
		(input.target !== "production" ||
			Object.keys(input.runtimeEnvironment).length !==
				RELAY_RUNTIME_ENV_KEYS.length ||
			input.runtimeEnvironment.HOBO_CI_CONFIG_SERVICE !== "infisical" ||
			RELAY_RUNTIME_ENV_KEYS.some((key) => {
				const value = input.runtimeEnvironment?.[key];
				return (
					!value ||
					value.length > 1024 ||
					[...value].some((character) => (character.codePointAt(0) ?? 0) < 32)
				);
			}))
	)
		throw new VercelSourceDeploymentError(
			"invalid-input",
			"The deployment runtime configuration is invalid.",
		);

	const blobs = new Map<string, Buffer>();
	const seenPaths = new Set<string>();
	const files = input.source.files.map((file) => {
		if (
			file.path === "" ||
			file.path.includes("\\") ||
			file.path
				.split("/")
				.some((part) => part === "" || part === "." || part === "..") ||
			seenPaths.has(file.path) ||
			(file.mode !== "100644" && file.mode !== "100755")
		)
			throw new VercelSourceDeploymentError(
				"invalid-source",
				"The pinned source contains an invalid file.",
			);
		seenPaths.add(file.path);
		const content = Buffer.from(file.content);
		const sha = createHash("sha1").update(content).digest("hex");
		const existing = blobs.get(sha);
		if (existing !== undefined && !existing.equals(content))
			throw new VercelSourceDeploymentError(
				"digest-collision",
				"Two source files have the same Vercel digest but different bytes.",
			);
		blobs.set(sha, content);
		return {
			file: file.path,
			sha,
			size: content.length,
			mode: Number.parseInt(file.mode, 8),
		};
	});
	const body = JSON.stringify({
		name: input.name,
		project: input.project,
		files,
		gitMetadata: {
			remoteUrl: `https://github.com/${input.repository}`,
			commitRef: input.ref,
			commitSha: input.source.commit,
			dirty: false,
		},
		meta: {
			hoboSourceCommit: input.source.commit,
			hoboStagedProduction: input.target === "production" ? "true" : "false",
		},
		env: {
			HOBO_CI_SOURCE_SHA: input.source.commit,
			...input.runtimeEnvironment,
		},
		projectSettings: {
			rootDirectory: input.rootDirectory,
			sourceFilesOutsideRootDirectory: true,
			...input.buildSettings,
		},
		...(input.target === "production"
			? { target: "production", autoAssignCustomDomains: false }
			: undefined),
	});
	const http = input.fetch ?? fetch;
	const team = `?teamId=${encodeURIComponent(input.teamId)}`;
	const headers = { Authorization: `Bearer ${input.token}` };
	const send = async (url: string, init: RequestInit): Promise<Response> => {
		if (input.signal?.aborted)
			throw new VercelSourceDeploymentError(
				"aborted",
				"The owner session changed before deployment.",
			);
		const remaining =
			input.deadline === undefined
				? 30_000
				: Math.min(30_000, input.deadline - Date.now());
		if (remaining <= 0)
			throw new VercelSourceDeploymentError(
				"deadline",
				"The source deployment deadline expired.",
			);
		try {
			return await http(url, {
				...init,
				redirect: "error",
				signal: input.signal
					? AbortSignal.any([input.signal, AbortSignal.timeout(remaining)])
					: AbortSignal.timeout(remaining),
			});
		} catch {
			throw new VercelSourceDeploymentError(
				"transport",
				"Vercel source deployment could not reach the API.",
			);
		}
	};
	const create = async () => {
		const response = await send(
			`https://api.vercel.com/v13/deployments${team}`,
			{
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body,
			},
		);
		let data: unknown;
		try {
			data = await readBoundedJsonResponse(response);
		} catch {
			throw new VercelSourceDeploymentError(
				"invalid-response",
				"Vercel returned an invalid deployment response.",
				response.status,
			);
		}
		return { response, data };
	};
	let attempt = await create();
	const providerError =
		object(attempt.data) && object(attempt.data.error)
			? attempt.data.error
			: attempt.data;
	if (
		!attempt.response.ok &&
		object(providerError) &&
		providerError.code === "missing_files"
	) {
		const missing = providerError.missing;
		if (
			!Array.isArray(missing) ||
			missing.some((sha) => typeof sha !== "string" || !blobs.has(sha))
		)
			throw new VercelSourceDeploymentError(
				"invalid-missing-file",
				"Vercel requested an unknown missing file.",
			);
		const pending = [...new Set(missing)];
		let next = 0;
		let stopped = false;
		const upload = async () => {
			while (!stopped && next < pending.length) {
				const sha = pending[next++];
				const data = typeof sha === "string" ? blobs.get(sha) : undefined;
				if (sha === undefined || data === undefined)
					throw new VercelSourceDeploymentError(
						"invalid-missing-file",
						"Vercel requested an unknown missing file.",
					);
				let succeeded = false;
				for (let tries = 0; tries < 3 && !succeeded; tries++) {
					const response = await send(
						`https://api.vercel.com/v2/files${team}`,
						{
							method: "POST",
							headers: {
								...headers,
								"Content-Type": "application/octet-stream",
								"Content-Length": String(data.length),
								"x-now-digest": sha,
								"x-now-size": String(data.length),
							},
							body: new Uint8Array(data),
						},
					);
					await response.body?.cancel().catch(() => {});
					if (response.ok) succeeded = true;
					else if (
						(response.status === 429 || response.status >= 500) &&
						tries < 2
					)
						await (
							input.sleep ??
							((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
						)(250 * 2 ** tries);
					else
						throw new VercelSourceDeploymentError(
							"upload-failed",
							"Vercel refused a source file upload.",
							response.status,
						);
				}
			}
		};
		const results = await Promise.allSettled(
			Array.from({ length: Math.min(12, pending.length) }, async () => {
				try {
					await upload();
				} catch (error) {
					stopped = true;
					throw error;
				}
			}),
		);
		const failed = results.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") {
			if (failed.reason instanceof VercelSourceDeploymentError)
				throw failed.reason;
			throw new VercelSourceDeploymentError(
				"upload-failed",
				"Vercel source upload failed.",
			);
		}
		attempt = await create();
	}
	if (!attempt.response.ok || !object(attempt.data))
		throw new VercelSourceDeploymentError(
			"deploy-failed",
			"Vercel refused the source deployment.",
			attempt.response.status,
		);
	const { id, url } = attempt.data;
	if (
		typeof id !== "string" ||
		!/^dpl_[A-Za-z0-9]+$/u.test(id) ||
		typeof url !== "string" ||
		!/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.vercel\.app$/u.test(url)
	)
		throw new VercelSourceDeploymentError(
			"invalid-response",
			"Vercel returned an invalid deployment receipt.",
		);
	return { id, url: `https://${url}` };
}
