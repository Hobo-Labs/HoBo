/**
 * AWS Signature Version 4 for Route53 and the other AWS REST APIs this package
 * calls — re-exported from `@hobo/core`.
 *
 * The algorithm itself used to live here. It moved to
 * `@hobo/core`'s `ports/aws-sigv4.ts` because it is deterministic crypto over
 * `node:crypto` with no HoBo domain semantics in it, and because the layer-2
 * provider adapters (`@hobo/provider-aws`) that need it may import
 * `@hobo/core` and nothing else HoBo — reaching into this layer-3 package
 * would be a boundary violation. Every name this module used to export is
 * re-exported below unchanged, so nothing downstream moves; what is gone is
 * the second copy of the signing code, which is the only thing worse than a
 * signer in the wrong package.
 *
 * The Route53 signer stays here: picking `us-east-1`/`route53` is a fact about
 * Route53, not about SigV4.
 *
 * Spec: https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
 */
import {
	type AwsCredentials,
	type SignAwsRequestInput,
	type SignedAwsRequest,
	signAwsRequest,
} from "@hobo/core/aws-sigv4";

export {
	type AwsCredentials,
	hmac,
	type SignAwsRequestInput,
	type SignedAwsRequest,
	sha256Hex,
	signAwsRequest,
} from "@hobo/core/aws-sigv4";

/** Default Route53 signer using the shared SigV4 primitive. */
export function createRoute53SigV4Signer(
	credentials: AwsCredentials,
): (input: {
	readonly method: string;
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: string;
}) => Promise<{ readonly headers: Record<string, string> }> {
	return async (input) => {
		const signed: SignedAwsRequest = signAwsRequest({
			method: input.method,
			url: input.url,
			headers: input.headers,
			body: input.body,
			// Route53 is a global service; signing region is us-east-1.
			region: "us-east-1",
			service: "route53",
			credentials,
		} satisfies SignAwsRequestInput);
		return { headers: signed.headers };
	};
}
