import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type BitwardenLogin = { loginAccessToken(accessToken: string): Promise<void> };
type RealBitwardenClient = { auth(): BitwardenLogin };
type BitwardenClientOptions = {
	readonly apiUrl?: string;
	readonly identityUrl?: string;
	readonly userAgent?: string;
};
type RealBitwardenClientConstructor = new (
	options: BitwardenClientOptions,
) => RealBitwardenClient;

function anchorCandidates(): string[] {
	const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
	const checkoutRoot = fileURLToPath(new URL("../../..", import.meta.url));
	return [
		`${pluginRoot}/agent-plugin-anchor.js`,
		`${checkoutRoot}/packages/hobo-ci/package.json`,
		`${checkoutRoot}/packages/hobo/package.json`,
	];
}

function loadRealConstructor(): RealBitwardenClientConstructor {
	const failures: string[] = [];
	for (const anchor of anchorCandidates()) {
		try {
			const requireFromAnchor = createRequire(anchor);
			const pkg: { BitwardenClient?: RealBitwardenClientConstructor } =
				requireFromAnchor(requireFromAnchor.resolve("@bitwarden/sdk-napi"));
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

	auth(): BitwardenLogin {
		if (this.#real === undefined) {
			const RealClient = loadRealConstructor();
			this.#real = new RealClient(this.#options);
		}
		return this.#real.auth();
	}
}
