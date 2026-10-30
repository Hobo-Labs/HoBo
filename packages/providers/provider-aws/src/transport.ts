/**
 * The AWS-scoped guard policy for the injected HTTP transport.
 *
 * Why this module exists: the resolvers in `./resolvers.ts` call AWS service
 * APIs directly — there is no IaC engine in the middle — and every one of
 * those requests carries a SigV4 signature computed from a live access key. A
 * driver that trusts whatever transport (and whatever URL) it is handed can be
 * pointed at an attacker's origin by one bad config value, and the signature,
 * the access key id, and any session token go with it. So the transport is
 * always injected, and the policy below is what makes any injected transport
 * safe on this path. The enforcement itself lives in `guardTransport()` in
 * `@hobo/core`; this module owns only the AWS-specific numbers and hosts, so
 * the rule set cannot drift per provider package.
 *
 * AWS differs from the single-origin providers in one way that matters: its
 * endpoints are *regional*, so there is no one host to allowlist. The policy
 * is therefore built per region and lists the exact regional host of each
 * service a resolver in this package addresses — seven hosts, no wildcards. A
 * region that does not parse is refused rather than interpolated, because
 * `s3.{whatever}.amazonaws.com` is a request to a host nobody reviewed.
 *
 * The path allowlist is `/` and only `/`, which looks permissive and is not:
 * five services accept exactly one path (`/`, with the operation in
 * a header or a form body), S3 addresses a bucket and Lambda uses its versioned
 * function paths. There is
 * no narrower prefix that admits `/{bucket}` without also admitting every
 * sibling path, so the honest constraint here is the host list plus the
 * scheme, and this comment says so rather than implying a path check is doing
 * work it is not.
 *
 * China (`cn-`) regions are refused: they terminate at `amazonaws.com.cn`, a
 * different suffix, and guessing the suffix from a region prefix is how a
 * credential ends up addressed to the wrong partition.
 *
 * Nothing here reaches for a global `fetch`. Reaching the network is always
 * something a host decided to hand over, never something a library reached for.
 *
 * HONEST SCOPE: the guard constrains the request this package composes and the
 * response it accepts. It cannot prove the injected transport honours
 * `timeoutMs`, refuses to follow a 302 itself, or terminates TLS against the
 * real AWS certificate — those are the host's obligations. Passing the guard
 * is not evidence that a live call was made.
 */

import {
	guardTransport,
	type HttpTransport,
	type TransportGuardPolicy,
} from "@hobo/core";

/**
 * The AWS services this package's resolvers address. Each one contributes
 * exactly one regional host to the allowlist.
 */
// public-contract: the closed set of AWS service endpoints the resolvers may address, and the host allowlist is derived from it.
export const AWS_RESOLVER_SERVICES = Object.freeze([
	"dynamodb",
	"lambda",
	"s3",
	"secretsmanager",
	"sns",
	"sqs",
	"ssm",
] as const);

export type AwsResolverService = (typeof AWS_RESOLVER_SERVICES)[number];

/**
 * The commercial-partition endpoint suffix. GovCloud regions (`us-gov-*`) also
 * terminate here; China regions do not, which is why they are refused above.
 */
// public-contract: the endpoint suffix every allowlisted AWS host ends with.
export const AWS_ENDPOINT_SUFFIX = "amazonaws.com";

/**
 * Region grammar: two letters, one or two lowercase words, one digit —
 * `us-east-1`, `ap-southeast-2`, `us-gov-west-1`. Anything else is refused
 * rather than interpolated into a hostname.
 */
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+){1,2}-\d$/u;

/**
 * The only path prefix. See the module note: this admits every path on these
 * hosts, and the host list is what constrains reach.
 */
// public-contract: the path allowlist for the AWS transport guard; see the module note on why it is the root.
export const AWS_ALLOWED_PATH_PREFIXES = Object.freeze(["/"] as const);

/**
 * Caps. These are control-plane calls: small bodies, quick answers. A response
 * larger or slower than this is a contract change, not a big success.
 */
export const AWS_MAX_TIMEOUT_MS = 15_000;
export const AWS_MAX_RESPONSE_BYTES = 512 * 1024;

/** Refusal from this module, kept structural so callers can branch on it. */
export class AwsTransportConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AwsTransportConfigError";
	}
}

/**
 * Parse a region into the form the host builder accepts. Exported because a
 * resolver factory should refuse a bad region at construction time rather than
 * on the first call, when a credential is already in hand.
 */
export function parseAwsRegion(region: string): string {
	if (!REGION_PATTERN.test(region)) {
		throw new AwsTransportConfigError(
			`aws region: expected a region matching ${REGION_PATTERN.source} (for example "us-east-1"), received ${JSON.stringify(region)}; a region that does not parse would be interpolated into a hostname nobody allowlisted`,
		);
	}
	if (region.startsWith("cn-")) {
		throw new AwsTransportConfigError(
			`aws region ${JSON.stringify(region)} is in the China partition, whose endpoints terminate at amazonaws.com.cn rather than ${AWS_ENDPOINT_SUFFIX}; this package refuses the region instead of guessing the suffix`,
		);
	}
	return region;
}

/** The regional host for one service. */
export function awsServiceHost(
	service: AwsResolverService,
	region: string,
): string {
	return `${service}.${parseAwsRegion(region)}.${AWS_ENDPOINT_SUFFIX}`;
}

/** Every host the resolvers may reach in one region, sorted for determinism. */
export function awsAllowedHosts(region: string): readonly string[] {
	return Object.freeze(
		AWS_RESOLVER_SERVICES.map((service) =>
			awsServiceHost(service, region),
		).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
	);
}

/**
 * The AWS guard policy for one region. A function rather than a constant so a
 * caller always receives the frozen policy this package stands behind and can
 * never mutate a shared object out from under another caller.
 */
export function awsTransportPolicy(region: string): TransportGuardPolicy {
	return Object.freeze({
		allowedHosts: awsAllowedHosts(region),
		allowedPathPrefixes: AWS_ALLOWED_PATH_PREFIXES,
		maxTimeoutMs: AWS_MAX_TIMEOUT_MS,
		maxResponseBytes: AWS_MAX_RESPONSE_BYTES,
	});
}

/**
 * Wrap an injected transport with the AWS policy for one region. This is the
 * only transport the resolvers should ever be handed; passing an unguarded one
 * is legal TypeScript and a security defect.
 */
export function guardedAwsTransport(
	inner: HttpTransport,
	region: string,
): HttpTransport {
	return guardTransport(inner, awsTransportPolicy(region));
}

/**
 * Build an absolute AWS service URL.
 *
 * Callers pass an already-encoded path (and query); this only joins, so a
 * caller that forgets to encode a bucket name gets a URL the guard will judge
 * and the signer will canonicalize, not a silently repaired one.
 */
export function awsServiceUrl(
	service: AwsResolverService,
	region: string,
	path: string,
): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `https://${awsServiceHost(service, region)}${suffix}`;
}
