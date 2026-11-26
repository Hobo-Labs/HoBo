/**
 * Promotion: getting the artifact somewhere it will still exist tomorrow.
 *
 * This is the only exit from `none-expire`. It is a digest-to-digest copy into a
 * registry the operator controls, and it is deliberately not called "claim" or
 * "adopt": nothing about it changes the artifact's status on ttl.sh, which keeps
 * expiring on schedule. What changes is that a second, owned copy exists.
 *
 * Three refusals are load-bearing:
 *
 * - the destination cannot be another anonymous expiring registry
 *   (`parseOwnerControlledRegistry`), because that is a lifetime extension wearing
 *   ownership's clothes;
 * - the source lease must still be live, checked against the caller's clock reading
 *   before a tool is spawned, because a promotion that starts after expiry copies
 *   nothing and reports a tool error rather than the truth;
 * - an artifact pushed under an acknowledgement must be promoted into the registry
 *   that acknowledgement named, or the acknowledgement was decorative.
 *
 * The copy is verified by digest afterwards. On a registry where anyone may push
 * over a name, "the source now resolves to something else" is a scenario with a
 * mechanism behind it rather than a hypothetical.
 */
import { redactProviderText, TtlShProviderError } from "./errors.js";
import { parseJsonValue } from "./json.js";
import {
	type ArtifactPayload,
	isAcknowledgedTemporaryHandoff,
	type OwnerControlledRegistry,
	parseOwnerControlledRegistry,
} from "./payload.js";
import {
	assertArgvSafe,
	assertLeaseLive,
	type ProcessRunner,
	type TtlShPushRecord,
} from "./push.js";
import {
	assertNoCredentialMaterial,
	type TtlShProviderFact,
} from "./receipt.js";
import {
	parseArtifactDigest,
	parseArtifactName,
	type TtlShDigest,
} from "./reference.js";

/** A destination in a registry somebody is responsible for. */
export type PromotionTarget = {
	readonly registry: OwnerControlledRegistry;
	/** Repository path in the target registry. Slashes allowed here. */
	readonly repository: string;
	readonly tag: string;
	/** `<registry>/<repository>:<tag>`. */
	readonly ref: string;
};

const TARGET_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;

function targetInvalid(detail: string): never {
	throw new TtlShProviderError("PROMOTION_TARGET_INVALID", detail);
}

/**
 * Parse a promotion destination.
 *
 * Unlike an ephemeral name, a target name is *meant* to be recognisable — it lives
 * in a registry with accounts, so `acme/payments-api` is the right kind of name
 * there and would be refused here. What is still checked is the grammar, component
 * by component, so a `..` cannot enter a reference through the one place that
 * accepts slashes.
 */
export function parsePromotionTarget(input: {
	readonly registry: string;
	readonly repository: string;
	readonly tag: string;
}): PromotionTarget {
	const registry = parseOwnerControlledRegistry(input.registry);
	if (input.repository.length === 0 || input.repository.length > 255) {
		targetInvalid("promotion repository must be 1-255 characters");
	}
	for (const component of input.repository.split("/")) {
		if (!TARGET_COMPONENT.test(component)) {
			targetInvalid(
				`promotion repository component ${JSON.stringify(component)} is not a lowercase OCI name component`,
			);
		}
	}
	if (!TAG.test(input.tag)) {
		targetInvalid("promotion tag is not a valid OCI tag");
	}
	return {
		registry,
		repository: input.repository,
		tag: input.tag,
		ref: `${registry}/${input.repository}:${input.tag}`,
	};
}

/** Binaries allowed to copy. Same rule as the push path, same reason. */
export const COPY_TOOL_ALLOWLIST = ["crane"] as const;

/**
 * `crane copy ttl.sh/<name>@sha256:… <registry>/<repo>:<tag>`.
 *
 * By digest on the source side: promoting the *tag* would copy whatever currently
 * answers to that name, which on an anonymous registry is not necessarily what was
 * reviewed.
 */
export function buildCraneCopyArgv(input: {
	readonly source: TtlShPushRecord;
	readonly target: PromotionTarget;
	readonly binary?: string;
}): readonly string[] {
	const digestReference = `${input.source.reference.host}/${input.source.reference.name}@${input.source.digest}`;
	return assertArgvSafe([
		input.binary ?? "crane",
		"copy",
		digestReference,
		input.target.ref,
	]);
}

export type PromotionReceipt = {
	/** The digest-pinned source, as it was addressed on the ephemeral registry. */
	readonly sourceReference: string;
	readonly target: PromotionTarget;
	/** The digest that now exists in both registries. Equal by verification. */
	readonly digest: TtlShDigest;
	readonly promotedAtMs: number;
	/** How much of the source lease was left when the copy ran. */
	readonly sourceRemainingMs: number;
	/**
	 * Whether this promotion discharged an acknowledged temporary handoff. Recorded
	 * so the projection tracking outstanding handoffs can close them.
	 */
	readonly dischargedAcknowledgement: boolean;
};

export type PromoteArtifactInput = {
	readonly runner: ProcessRunner;
	readonly record: TtlShPushRecord;
	readonly target: PromotionTarget;
	/** The payload description the artifact was pushed under. */
	readonly payload: ArtifactPayload;
	/** Injected clock reading. Nothing in this package reads `Date.now()`. */
	readonly nowMs: number;
	readonly binary?: string;
	readonly timeoutMs?: number;
	readonly env?: Readonly<Record<string, string>>;
};

const REPORTED_DIGEST = /\bsha256:[0-9a-f]{64}\b/u;

/**
 * How long is left before a promotion becomes impossible.
 *
 * Separate from the copy so a scheduler can ask without moving bytes, and so an
 * acknowledged handoff's own deadline — tighter than the TTL by construction — is
 * what gets reported rather than the raw expiry.
 */
export function promotionUrgency(input: {
	readonly record: TtlShPushRecord;
	readonly payload: ArtifactPayload;
	readonly nowMs: number;
}) {
	const remainingMs = Math.max(input.record.expiresAtMs - input.nowMs, 0);
	const expired = input.record.expiresAtMs <= input.nowMs;
	if (!isAcknowledgedTemporaryHandoff(input.payload)) {
		return { expired, remainingMs, dueInMs: remainingMs };
	}
	const deadlineMs =
		input.record.pushedAtMs +
		input.payload.acknowledgement.promoteWithinMinutes * 60_000;
	return {
		expired,
		remainingMs,
		dueInMs: Math.max(deadlineMs - input.nowMs, 0),
	};
}

/**
 * Copy the artifact into an owner-controlled registry, by digest, and verify it.
 */
export async function promoteArtifact(
	input: PromoteArtifactInput,
): Promise<PromotionReceipt> {
	// The lease check comes first: everything after it costs bytes.
	assertLeaseLive(input.record, input.nowMs);

	if (isAcknowledgedTemporaryHandoff(input.payload)) {
		const agreed = input.payload.acknowledgement.promotionTarget;
		if (input.target.registry !== agreed) {
			throw new TtlShProviderError(
				"PROMOTION_TARGET_INVALID",
				`this artifact was pushed under an acknowledgement naming ${agreed} as its promotion target, not ${input.target.registry}`,
				{ detail: { agreed, requested: input.target.registry } },
			);
		}
	}

	// Re-parsed rather than trusted: the record may have come back from a read
	// store, and a name or digest that no longer parses is not one to spawn a tool
	// with.
	parseArtifactName(input.record.reference.name);
	const expected = parseArtifactDigest(input.record.digest);

	const argv = buildCraneCopyArgv({
		source: input.record,
		target: input.target,
		...(input.binary !== undefined ? { binary: input.binary } : undefined),
	});

	let result: Awaited<ReturnType<ProcessRunner["run"]>>;
	try {
		result = await input.runner.run(argv, {
			// Deliberately not the ambient environment. An inherited DOCKER_CONFIG
			// would be offered to the *source* registry too, which authenticates
			// nobody and should never be sent a credential.
			env: input.env ?? {},
			timeoutMs: input.timeoutMs ?? 600_000,
		});
	} catch (cause) {
		throw new TtlShProviderError(
			"PROVIDER_OPERATION_AMBIGUOUS",
			"the promotion did not complete; the target may hold a partial upload, and re-running the same digest copy is the way to find out",
			{
				cause: cause instanceof Error ? cause : new Error(String(cause)),
				detail: { target: input.target.ref },
			},
		);
	}

	if (result.code !== 0) {
		throw new TtlShProviderError(
			"ARTIFACT_PUSH_FAILED",
			`crane copy exited with code ${result.code}: ${redactProviderText(result.stderr, 512)}`,
			{ detail: { code: result.code, target: input.target.ref } },
		);
	}

	const reported = REPORTED_DIGEST.exec(`${result.stdout}\n${result.stderr}`);
	const reportedDigest = reported?.[0];
	if (
		reportedDigest !== undefined &&
		parseArtifactDigest(reportedDigest) !== expected
	) {
		// Either the tool copied something else or the source name now resolves to
		// different content. Both are real on an anonymous registry, and neither is
		// a successful promotion.
		throw new TtlShProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the promoted copy reports a different digest than the source artifact",
			{ detail: { expected, reported: reportedDigest } },
		);
	}

	return {
		sourceReference: `${input.record.reference.host}/${input.record.reference.name}@${expected}`,
		target: input.target,
		digest: expected,
		promotedAtMs: input.nowMs,
		sourceRemainingMs: input.record.expiresAtMs - input.nowMs,
		dischargedAcknowledgement: isAcknowledgedTemporaryHandoff(input.payload),
	};
}

/**
 * The observation a promotion produces, for the claim coordinator to reduce.
 *
 * One fact, not two: nothing about the ephemeral lease changed, so emitting a
 * lease event here would tell the read model that an artifact stopped expiring
 * when it did not. What the control plane learns is that an owned copy exists and
 * where it is — which is precisely what closes an outstanding acknowledged
 * handoff in the projection.
 */
export function toPromotionFacts(
	receipt: PromotionReceipt,
	record: TtlShPushRecord,
): readonly TtlShProviderFact[] {
	const facts: readonly TtlShProviderFact[] = [
		{
			kind: "provider.ttl-sh.artifact.promoted",
			occurredAtMs: receipt.promotedAtMs,
			resourceRef: record.resourceRef,
			pullReference: record.reference.pullReference,
			digest: receipt.digest,
			detail: {
				targetRegistry: receipt.target.registry,
				targetReference: receipt.target.ref,
				sourceRemainingMs: receipt.sourceRemainingMs,
				dischargedAcknowledgement: receipt.dischargedAcknowledgement,
				// Said explicitly because the opposite is the intuitive reading:
				// a promoted artifact is still deleted from ttl.sh on schedule.
				sourceStillExpires: true,
			},
		},
	];
	assertNoCredentialMaterial(
		parseJsonValue(JSON.stringify(facts)),
		"the ttl.sh promotion facts",
	);
	return facts;
}
