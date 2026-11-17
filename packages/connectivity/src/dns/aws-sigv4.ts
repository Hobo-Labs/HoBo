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
			region: "us-east-1",
			service: "route53",
			credentials,
		} satisfies SignAwsRequestInput);
		return { headers: signed.headers };
	};
}
