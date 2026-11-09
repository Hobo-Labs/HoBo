/**
 * The push path, expressed as a port.
 *
 * Pushing an image is the one genuinely effectful thing this package does, and
 * the obvious implementation — shell out to whatever CLI is on PATH — is the
 * one that cannot be tested, cannot be reasoned about, and quietly inherits the
 * ambient Docker credentials of whoever ran it. So the effect is an injected
 * {@link OciPushExecutor}, and the shell-out is one implementation of it:
 *
 * - Every external command is an argv array handed to an injected
 *   {@link ProcessRunner}. There is no shell, no string concatenation, no
 *   interpolation. A name containing `; rm -rf /` cannot reach here (the
 *   reference parser refuses it) and would still be one inert argv element.
 * - The binary and every flag come from an allowlist. A caller cannot pass
 *   `--insecure` — dropping TLS to an anonymous registry means the artifact is
 *   both unauthenticated *and* interceptible — and cannot pass any of the
 *   credential-bearing flags, because there is no credential to pass.
 * - {@link assertArgvSafe} is the last line of defence before a spawn, in the
 *   same shape `@hobo/provider-neon` uses for `pg_dump`.
 *
 * Idempotency is content-addressed rather than key-addressed. Two pushes of
 * the same digest to the same reference are the same push, and
 * {@link pushArtifact} adopts the recorded lease instead of spending a second
 * one. Two *different* digests under one reference is a refusal: a reference
 * whose content silently changed is a reference nobody can verify.
 */
import { JWT_DETECTOR } from "@hobo/provider-redaction";
import {
	containsControlChar,
	redactProviderText,
	TtlShProviderError,
} from "./errors.js";
import {
	expiresAtMs,
	parseArtifactDigest,
	type TtlShDigest,
	type TtlShImageReference,
} from "./reference.js";

export type ProcessRunOptions = {
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly cwd?: string;
};

export type ProcessResult = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
};

/**
 * Implementations MUST spawn without a shell (`shell: false`) and MUST NOT
 * inherit the ambient environment beyond what `env` provides — an inherited
 * `DOCKER_CONFIG` is how a credential reaches an anonymous registry.
 */
export interface ProcessRunner {
	run(
		argv: readonly string[],
		options: ProcessRunOptions,
	): Promise<ProcessResult>;
}

/** The local artifact being handed to the registry. */
export type OciArtifact = {
	/** Path to an OCI layout or docker-archive tarball. */
	readonly path: string;
	readonly digest: TtlShDigest;
	readonly sizeBytes: number;
};

export type OciPushRequest = {
	readonly reference: TtlShImageReference;
	readonly artifact: OciArtifact;
	readonly timeoutMs: number;
};

export type OciPushOutcome = {
	/** The digest the registry reports. Must match the declared one. */
	readonly digest: TtlShDigest;
	readonly toolVersion?: string;
};

/** The effectful boundary. Everything above it is pure. */
export interface OciPushExecutor {
	push(request: OciPushRequest): Promise<OciPushOutcome>;
}

/** Binaries this package is willing to spawn. */
export const PUSH_TOOL_ALLOWLIST = ["crane"] as const;

/**
 * Flags this package is willing to pass.
 *
 * Everything absent is refused rather than forwarded, which is why this is an
 * allowlist rather than a denylist of the dangerous ones: the next dangerous
 * flag is the one nobody has thought of yet.
 */
export const PUSH_FLAG_ALLOWLIST = ["--platform=all"] as const;

/**
 * Credential shapes refused in a command line; exported so a test can sweep
 * each for linear growth.
 */
export const ARGV_CREDENTIAL_PATTERNS: readonly RegExp[] = [
	/^--?(?:password|password-stdin|username|token|auth|creds?)\b/iu,
	/\/\/[^/\s:@]+:[^/\s:@]+@/u,
	/\bBearer\s/iu,
	// The shared JWT detector: `\bey…` started again at every `ey` in a run.
	JWT_DETECTOR,
];

function assertArgvValue(value: string, what: string): string {
	if (value.length === 0 || value.length > 1024) {
		throw new TtlShProviderError(
			"UNSAFE_TOOL_INVOCATION",
			`${what} must be 1-1024 characters`,
		);
	}
	if (containsControlChar(value)) {
		throw new TtlShProviderError(
			"UNSAFE_TOOL_INVOCATION",
			`${what} contains a control character and cannot be passed to a child process`,
		);
	}
	return value;
}

/** Last line of defence before a command is spawned. */
export function assertArgvSafe(argv: readonly string[]): readonly string[] {
	if (argv.length === 0) {
		throw new TtlShProviderError(
			"UNSAFE_TOOL_INVOCATION",
			"refusing to run an empty argv",
		);
	}
	const binary = argv[0];
	if (binary === undefined) {
		throw new TtlShProviderError(
			"UNSAFE_TOOL_INVOCATION",
			"refusing to run an empty argv",
		);
	}
	if (!isAllowedPushTool(binary)) {
		throw new TtlShProviderError(
			"UNSAFE_TOOL_INVOCATION",
			`refusing to spawn ${JSON.stringify(binary)}; only ${PUSH_TOOL_ALLOWLIST.join(", ")} may push for this provider`,
			{ detail: { binary } },
		);
	}
	for (const element of argv) {
		assertArgvValue(element, "argv element");
		for (const pattern of ARGV_CREDENTIAL_PATTERNS) {
			if (pattern.test(element)) {
				throw new TtlShProviderError(
					"CREDENTIAL_REFUSED",
					"refusing to place credential-shaped material in argv; ttl.sh accepts no credentials",
				);
			}
		}
		if (element.startsWith("-") && element !== binary) {
			if (!isAllowedPushFlag(element)) {
				throw new TtlShProviderError(
					"UNSAFE_TOOL_INVOCATION",
					`refusing the unallowlisted flag ${JSON.stringify(element)}`,
					{ detail: { flag: element } },
				);
			}
		}
	}
	return argv;
}

function isAllowedPushTool(binary: string): boolean {
	for (const allowed of PUSH_TOOL_ALLOWLIST) {
		if (allowed === binary) return true;
	}
	return false;
}

function isAllowedPushFlag(flag: string): boolean {
	for (const allowed of PUSH_FLAG_ALLOWLIST) {
		if (allowed === flag) return true;
	}
	return false;
}

export type CranePushInput = {
	readonly reference: TtlShImageReference;
	readonly artifactPath: string;
	readonly binary?: string;
	readonly allArchitectures?: boolean;
};

/**
 * `crane push <tarball> ttl.sh/<name>:<ttl>`.
 *
 * The reference is taken from the parsed type rather than a caller-supplied
 * string, so the host allowlist and the unguessable-name rule hold all the way
 * down to the process boundary instead of only at the API surface.
 */
export function buildCranePushArgv(input: CranePushInput): readonly string[] {
	const argv = [
		assertArgvValue(input.binary ?? "crane", "push binary"),
		"push",
		assertArgvValue(input.artifactPath, "artifact path"),
		input.reference.pullReference,
		...(input.allArchitectures === true ? ["--platform=all"] : []),
	];
	return assertArgvSafe(argv);
}

const REPORTED_DIGEST = /\bsha256:[0-9a-f]{64}\b/u;
const RATE_LIMITED = /\b429\b|too many requests|rate ?limit/iu;
const AMBIGUOUS =
	/\b5\d\d\b|timeout|timed out|connection reset|eof|broken pipe|i\/o/iu;

/**
 * The default executor: a `crane push` behind an injected runner.
 *
 * Failure mapping is the interesting part. A push that got a 5xx or died on a
 * socket may or may not have landed, and calling that "failed" would let a
 * caller mint a second lease for content that is already there. It is reported
 * as ambiguous, and resolved by re-pushing the same digest — which, because
 * the registry is content-addressed and this package keys its ledger on the
 * digest, adopts rather than duplicates.
 */
export function createCranePushExecutor(options: {
	readonly runner: ProcessRunner;
	readonly binary?: string;
	readonly env?: Readonly<Record<string, string>>;
}): OciPushExecutor {
	return {
		async push(request) {
			const argv = buildCranePushArgv({
				reference: request.reference,
				artifactPath: request.artifact.path,
				...(options.binary !== undefined
					? { binary: options.binary }
					: undefined),
			});

			let result: ProcessResult;
			try {
				result = await options.runner.run(argv, {
					// Deliberately not the ambient environment: an inherited
					// DOCKER_CONFIG or REGISTRY_AUTH_FILE is a credential this
					// registry must never be offered.
					env: options.env ?? {},
					timeoutMs: request.timeoutMs,
				});
			} catch (cause) {
				throw new TtlShProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					"the push did not complete; re-push the same digest to find out whether the artifact is there",
					{
						cause: cause instanceof Error ? cause : new Error(String(cause)),
						detail: { reference: request.reference.pullReference },
					},
				);
			}

			if (result.code !== 0) {
				const stderr = redactProviderText(result.stderr, 512);
				if (RATE_LIMITED.test(result.stderr)) {
					throw new TtlShProviderError(
						"PROVIDER_RATE_LIMITED",
						`ttl.sh rate limited the push: ${stderr}`,
						{
							retryable: true,
							detail: { code: result.code },
						},
					);
				}
				if (AMBIGUOUS.test(result.stderr)) {
					throw new TtlShProviderError(
						"PROVIDER_OPERATION_AMBIGUOUS",
						`the push may or may not have landed: ${stderr}`,
						{ detail: { code: result.code } },
					);
				}
				throw new TtlShProviderError(
					"ARTIFACT_PUSH_FAILED",
					`crane push exited with code ${result.code}: ${stderr}`,
					{ detail: { code: result.code } },
				);
			}

			const reported = REPORTED_DIGEST.exec(
				`${result.stdout}\n${result.stderr}`,
			);
			if (reported === null) {
				throw new TtlShProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"the push tool reported no digest, so there is nothing to pin the artifact to",
				);
			}
			const reportedDigest = reported[0];
			if (reportedDigest === undefined) {
				throw new TtlShProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"the push tool reported no digest, so there is nothing to pin the artifact to",
				);
			}
			const digest = parseArtifactDigest(reportedDigest);
			if (digest !== request.artifact.digest) {
				// A different digest is different content. Recording the
				// declared one would produce a receipt that does not describe
				// what is actually in the registry.
				throw new TtlShProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"ttl.sh reported a digest that is not the one pushed",
					{ detail: { reported: digest, declared: request.artifact.digest } },
				);
			}
			return { digest };
		},
	};
}

export type PushState = "in-flight" | "pushed" | "failed";

export type PushLedgerRecord = {
	readonly pullReference: string;
	readonly state: PushState;
	readonly digest?: TtlShDigest;
	readonly attemptedAtMs: number;
	readonly expiresAtMs?: number;
};

/**
 * Local memory of what was pushed where.
 *
 * ttl.sh has no list endpoint and no account, so this is the only record that
 * a reference was ever used. It is an optimization and a safety check, never a
 * source of truth about the registry.
 */
export interface PushLedger {
	get(pullReference: string): Promise<PushLedgerRecord | undefined>;
	put(record: PushLedgerRecord): Promise<void>;
}

export function createInMemoryPushLedger(
	seed: readonly PushLedgerRecord[] = [],
): PushLedger {
	const records = new Map<string, PushLedgerRecord>(
		seed.map((record) => [record.pullReference, record]),
	);
	return {
		async get(pullReference) {
			return records.get(pullReference);
		},
		async put(record) {
			records.set(record.pullReference, record);
		},
	};
}

// domain-view: the push record is the driver's aggregate — parsed reference, verified digest, and the locally computed expiry; the proto message is its wire form.
export type TtlShPushRecord = {
	readonly definitionId: string;
	readonly providerId: string;
	readonly resourceRef: string;
	readonly reference: TtlShImageReference;
	readonly digest: TtlShDigest;
	readonly sizeBytes: number;
	readonly pushedAtMs: number;
	readonly expiresAtMs: number;
	/** Local arithmetic over the requested TTL; ttl.sh reports no expiry. */
	readonly expirySource: "computed-from-ttl";
	/** True when an identical digest was already recorded for this reference. */
	readonly adopted: boolean;
};

export type PushArtifactInput = {
	readonly executor: OciPushExecutor;
	readonly ledger: PushLedger;
	readonly reference: TtlShImageReference;
	readonly artifact: OciArtifact;
	/** Injected clock. Nothing in this package reads `Date.now()`. */
	readonly nowMs: number;
	readonly definitionId: string;
	readonly providerId: string;
	readonly resourceRef: string;
	readonly timeoutMs?: number;
};

/**
 * Push an artifact, at most once per (reference, digest).
 *
 * A recorded push whose lease has already expired is treated as absent: the
 * registry has deleted the content, so a fresh push is the correct behaviour
 * rather than an error. What is never allowed is a second *different* digest
 * under a reference somebody may already be pulling.
 */
export async function pushArtifact(
	input: PushArtifactInput,
): Promise<TtlShPushRecord> {
	const pullReference = input.reference.pullReference;
	const existing = await input.ledger.get(pullReference);

	if (existing?.state === "pushed" && existing.digest !== undefined) {
		const live =
			existing.expiresAtMs === undefined || existing.expiresAtMs > input.nowMs;
		if (live && existing.digest !== input.artifact.digest) {
			throw new TtlShProviderError(
				"REFERENCE_REUSED",
				"this ttl.sh reference already carries different content; mint a new name rather than overwriting one a host may be pulling",
				{ detail: { pullReference } },
			);
		}
		if (live) {
			return {
				definitionId: input.definitionId,
				providerId: input.providerId,
				resourceRef: input.resourceRef,
				reference: input.reference,
				digest: existing.digest,
				sizeBytes: input.artifact.sizeBytes,
				pushedAtMs: existing.attemptedAtMs,
				expiresAtMs:
					existing.expiresAtMs ??
					expiresAtMs(input.reference, existing.attemptedAtMs),
				expirySource: "computed-from-ttl",
				adopted: true,
			};
		}
	}

	await input.ledger.put({
		pullReference,
		state: "in-flight",
		attemptedAtMs: input.nowMs,
	});

	let outcome: OciPushOutcome;
	try {
		outcome = await input.executor.push({
			reference: input.reference,
			artifact: input.artifact,
			timeoutMs: input.timeoutMs ?? 300_000,
		});
	} catch (cause) {
		if (
			cause instanceof TtlShProviderError &&
			cause.code === "PROVIDER_OPERATION_AMBIGUOUS"
		) {
			// Left in-flight on purpose: the content is addressed by digest,
			// so the next attempt re-pushes the same bytes rather than
			// minting a second lease.
			throw cause;
		}
		await input.ledger.put({
			pullReference,
			state: "failed",
			attemptedAtMs: input.nowMs,
		});
		if (cause instanceof Error) throw cause;
		throw new Error(String(cause));
	}

	const expires = expiresAtMs(input.reference, input.nowMs);
	await input.ledger.put({
		pullReference,
		state: "pushed",
		digest: outcome.digest,
		attemptedAtMs: input.nowMs,
		expiresAtMs: expires,
	});

	return {
		definitionId: input.definitionId,
		providerId: input.providerId,
		resourceRef: input.resourceRef,
		reference: input.reference,
		digest: outcome.digest,
		sizeBytes: input.artifact.sizeBytes,
		pushedAtMs: input.nowMs,
		expiresAtMs: expires,
		expirySource: "computed-from-ttl",
		adopted: false,
	};
}

/** Refuse to hand out a pull reference whose lease is already over. */
export function assertLeaseLive(record: TtlShPushRecord, nowMs: number): void {
	if (record.expiresAtMs <= nowMs) {
		throw new TtlShProviderError(
			"LEASE_EXPIRED",
			"this ttl.sh artifact has passed its TTL and has been deleted; push again to mint a new lease",
			{ detail: { pullReference: record.reference.pullReference } },
		);
	}
}
