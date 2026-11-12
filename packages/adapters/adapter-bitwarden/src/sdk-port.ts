/**
 * The part of the official Bitwarden Secrets Manager SDK's `BitwardenClient`
 * (`@bitwarden/sdk-napi` 1.0.0, `client.secrets()`) this adapter uses. The
 * SDK is not a dependency: a composition that has it builds the client, signs
 * it in with `client.auth().loginAccessToken(token)` (a machine account's
 * access token, held by the owner), and passes it; tests pass a fake.
 */

export type BitwardenSecretIdentifier = {
	readonly id: string;
	readonly key: string;
	readonly organizationId: string;
};

export type BitwardenSecret = {
	readonly id: string;
	readonly key: string;
	readonly value: string;
	readonly note: string;
	readonly organizationId: string;
	readonly projectId?: string | null;
	readonly revisionDate: Date | string;
};

export interface BitwardenSdkClient {
	secrets(): {
		list(
			organizationId: string,
		): Promise<{ readonly data: readonly BitwardenSecretIdentifier[] }>;
		get(id: string): Promise<BitwardenSecret>;
		create(
			organizationId: string,
			key: string,
			value: string,
			note: string,
			projectIds: string[],
		): Promise<BitwardenSecret>;
		update(
			organizationId: string,
			id: string,
			key: string,
			value: string,
			note: string,
			projectIds: string[],
		): Promise<BitwardenSecret>;
	};
}
