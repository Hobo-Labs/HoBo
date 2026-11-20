import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

type BitwardenLogin = { loginAccessToken(accessToken: string): Promise<void> };
type BitwardenSecretIdentifier = {
	readonly id: string;
	readonly key: string;
};
type BitwardenSecret = {
	readonly id: string;
	readonly key: string;
	readonly value: string;
	readonly note: string;
	readonly projectId?: string | null;
	readonly revisionDate: Date | string;
};
type BitwardenSecretsClient = {
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
type RealBitwardenClient = {
	auth(): BitwardenLogin;
	secrets(): BitwardenSecretsClient;
};
type BitwardenClientOptions = {
	readonly apiUrl?: string;
	readonly identityUrl?: string;
	readonly userAgent?: string;
};
type RealBitwardenClientConstructor = new (
	options: BitwardenClientOptions,
) => RealBitwardenClient;

function anchorCandidates(): { anchor: string; trustedRoot: string }[] {
	const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
	const checkoutRoot = fileURLToPath(new URL("../../..", import.meta.url));
	return [
		{
			anchor: path.join(pluginRoot, "agent-plugin-anchor.js"),
			trustedRoot: pluginRoot,
		},
		{
			anchor: path.join(checkoutRoot, "packages/hobo-ci/package.json"),
			trustedRoot: checkoutRoot,
		},
		{
			anchor: path.join(checkoutRoot, "packages/hobo/package.json"),
			trustedRoot: checkoutRoot,
		},
	];
}

function resolvedUnderTrustedRoot(
	resolved: string,
	trustedRoot: string,
): boolean {
	let realResolved: string;
	let realRoot: string;
	try {
		realResolved = realpathSync(resolved);
		realRoot = realpathSync(trustedRoot);
	} catch {
		return false;
	}
	const prefix = `${realRoot}${path.sep}`;
	return realResolved === realRoot || realResolved.startsWith(prefix);
}

function loadRealConstructor(): RealBitwardenClientConstructor {
	const failures: string[] = [];
	for (const { anchor, trustedRoot } of anchorCandidates()) {
		try {
			const requireFromAnchor = createRequire(anchor);
			const resolved = requireFromAnchor.resolve("@bitwarden/sdk-napi");
			if (!resolvedUnderTrustedRoot(resolved, trustedRoot)) {
				failures.push(
					`${anchor}: @bitwarden/sdk-napi resolved outside trusted root (${resolved})`,
				);
				continue;
			}
			const pkg: { BitwardenClient?: RealBitwardenClientConstructor } =
				requireFromAnchor(resolved);
			if (pkg.BitwardenClient === undefined) {
				failures.push(`${anchor}: no BitwardenClient export`);
				continue;
			}
			return pkg.BitwardenClient;
		} catch (error) {
			failures.push(
				`${anchor}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	throw new Error(
		`The HoBo plugin's Bitwarden store needs the native @bitwarden/sdk-napi package, which the portable bundle cannot carry. Run inside a HoBo checkout with installed dependencies (pnpm install), or install @bitwarden/sdk-napi under the plugin's node_modules. Resolution attempts:\n${failures.join("\n")}`,
	);
}

export class BitwardenClient {
	readonly #options: BitwardenClientOptions;
	#real: RealBitwardenClient | undefined;

	constructor(options: BitwardenClientOptions) {
		this.#options = options;
	}

	#realClient(): RealBitwardenClient {
		if (this.#real === undefined) {
			const RealClient = loadRealConstructor();
			this.#real = new RealClient(this.#options);
		}
		return this.#real;
	}

	auth(): BitwardenLogin {
		return this.#realClient().auth();
	}

	secrets(): BitwardenSecretsClient {
		return this.#realClient().secrets();
	}
}
