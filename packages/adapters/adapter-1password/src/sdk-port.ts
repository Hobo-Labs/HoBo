/**
 * The part of the official 1Password JavaScript SDK's `Client`
 * (`@1password/sdk` 0.4.0, `client.items`) this adapter uses. The SDK is not
 * a dependency: a composition that has it passes
 * `await sdk.createClient({ auth, integrationName, integrationVersion })`,
 * whose `items` satisfies this shape; tests pass a fake. `auth` is a
 * service-account token or `new DesktopAuth(accountName)` (the owner's
 * desktop app, unlocked by the owner).
 */

export type OnePasswordItemField = {
	id: string;
	title: string;
	fieldType: string;
	value: string;
	sectionId?: string;
};

export type OnePasswordItem = {
	id: string;
	title: string;
	category: string;
	vaultId: string;
	fields: OnePasswordItemField[];
	version: number;
};

export type OnePasswordItemOverview = {
	readonly id: string;
	readonly title: string;
	readonly vaultId: string;
};

export type OnePasswordItemCreateParams = {
	category: string;
	vaultId: string;
	title: string;
	fields: OnePasswordItemField[];
	tags: string[];
};

export interface OnePasswordSdkClient {
	readonly items: {
		list(vaultId: string): Promise<readonly OnePasswordItemOverview[]>;
		get(vaultId: string, itemId: string): Promise<OnePasswordItem>;
		create(params: OnePasswordItemCreateParams): Promise<OnePasswordItem>;
		put(item: OnePasswordItem): Promise<OnePasswordItem>;
	};
}
