import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { egressFrom } from "./egress.js";
import {
	captureAll,
	type OwnerChannel,
	ownerCaptureLine,
} from "./owner-channel.js";
import {
	ensureStoreCli,
	type RunCommand,
	type StoreCli,
	StoreCliInstallError,
} from "./store-cli.js";

// public-contract: the 1Password CLI release HoBo installs.
export const ONE_PASSWORD_CLI_VERSION = "2.30.3";

export interface Platform {
	readonly os: "linux" | "darwin" | "windows";
	readonly arch: "amd64" | "arm64";
}

export function currentPlatform(): Platform {
	return {
		os:
			process.platform === "darwin"
				? "darwin"
				: process.platform === "win32"
					? "windows"
					: "linux",
		arch: process.arch === "arm64" ? "arm64" : "amd64",
	};
}

/** The 1Password CLI for a platform: its official zip, or Homebrew on macOS. */
export function onePasswordCli(platform: Platform): StoreCli {
	const v = ONE_PASSWORD_CLI_VERSION;
	return {
		bin: "op",
		installedPath: (toolsDir) => path.join(toolsDir, "bin", "op"),
		async install(run, toolsDir) {
			if (platform.os === "darwin")
				return run("brew", ["install", "--cask", "1password-cli"]);
			const zip = path.join(toolsDir, `op_${v}.zip`);
			const fetched = await run("curl", [
				"-fsSL",
				"--create-dirs",
				"-o",
				zip,
				`https://cache.agilebits.com/dist/1P/op2/pkg/v${v}/op_${platform.os}_${platform.arch}_v${v}.zip`,
			]);
			if (fetched.code !== 0) return fetched;
			return run("unzip", ["-o", zip, "op", "-d", path.join(toolsDir, "bin")]);
		},
	};
}

const serviceAccountPayload = z.object({
	email: z.string().email(),
	muk: z.object({}),
	secretKey: z.string().min(1),
	srpX: z.string().min(1),
	signInAddress: z.string().min(1),
	userAuth: z.object({}),
});

const serviceAccountToken = z
	.string()
	.max(65_536)
	.regex(/^ops_[A-Za-z0-9_-]+$/u)
	.superRefine((token, context) => {
		try {
			const encoded = token.slice(4);
			const decoded = Buffer.from(encoded, "base64url");
			if (decoded.toString("base64url") !== encoded) {
				context.addIssue({ code: "custom" });
				return;
			}
			const payload = serviceAccountPayload.safeParse(
				JSON.parse(decoded.toString("utf8")),
			);
			if (!payload.success) context.addIssue({ code: "custom" });
		} catch {
			context.addIssue({ code: "custom" });
		}
	})
	.brand<"OnePasswordServiceAccountToken">();

export type OnePasswordServiceAccountToken = z.infer<
	typeof serviceAccountToken
>;

export function parseOnePasswordServiceAccountToken(
	token: string,
): OnePasswordServiceAccountToken | undefined {
	const parsed = serviceAccountToken.safeParse(token);
	return parsed.success ? parsed.data : undefined;
}

/**
 * `true`: 1Password answered and the account is scoped to exactly the vault.
 * `false`: 1Password answered and rejected the account or its scope.
 * `"unverifiable"`: no answer — the transport to 1Password failed (egress
 * proxy, CA bundle, network), so nothing is claimed about the account.
 */
export type OnePasswordServiceAccountVerdict = boolean | "unverifiable";

export type ValidateOnePasswordServiceAccount = (
	token: OnePasswordServiceAccountToken,
	vaultId: string,
) => Promise<OnePasswordServiceAccountVerdict>;

export interface OnePasswordAccessOptions {
	readonly family: "ci" | "cd";
	readonly vaultId: string;
	readonly run?: RunCommand;
	readonly which: (bin: string) => Promise<string | undefined>;
	readonly toolsDir: string;
	readonly emit: (line: string) => void;
	/** The owner is at this machine: their 1Password app can approve a sign-in. */
	readonly interactive: boolean;
	readonly platform?: Platform;
	readonly exists?: (file: string) => boolean;
	readonly now?: () => number;
	/** How to reach an owner who is not at this machine (a remote dev box). */
	readonly owner?: OwnerChannel;
	readonly validateServiceAccount: ValidateOnePasswordServiceAccount;
}

export const ONE_PASSWORD_SERVICE_ACCOUNT_CAPTURE = "OP_SERVICE_ACCOUNT_TOKEN";
export const ONE_PASSWORD_SERVICE_ACCOUNT_EXPIRES_AT =
	"OP_SERVICE_ACCOUNT_EXPIRES_AT";
export const ONE_PASSWORD_SERVICE_ACCOUNT_REUSE_MS = 24 * 60 * 60_000;

export type OnePasswordAccess =
	| {
			readonly kind: "ready";
			readonly token: OnePasswordServiceAccountToken;
			readonly expiresAt: string;
	  }
	| {
			readonly kind: "refused";
			readonly code: string;
			readonly message: string;
			readonly remediation: readonly string[];
	  };

export function onePasswordVaultScope(
	vaults: readonly { readonly id: string }[],
	vaultId: string,
): boolean {
	return vaults.length === 1 && vaults[0]?.id === vaultId;
}

export const validateOnePasswordServiceAccount: ValidateOnePasswordServiceAccount =
	async (token, vaultId) => {
		let sdk: typeof import("@1password/sdk") | undefined;
		try {
			const egress = egressFrom(process.env);
			if (egress.proxy !== undefined || egress.caFile !== undefined)
				return "unverifiable";
			sdk = await import("@1password/sdk");
			const client = await sdk.createClient({
				auth: token,
				integrationName: "HoBo",
				integrationVersion: "1",
			});
			const vaults = await client.vaults.list({ decryptDetails: false });
			return onePasswordVaultScope(vaults, vaultId);
		} catch (error) {
			if (sdk === undefined) return "unverifiable";
			return error instanceof sdk.AuthExpiredError ? false : "unverifiable";
		}
	};

export async function provisionOnePasswordAccess(
	options: OnePasswordAccessOptions,
): Promise<OnePasswordAccess> {
	const fam = options.family.toUpperCase();
	const refused = (
		code: string,
		message: string,
		remediation: readonly string[],
	): OnePasswordAccess => ({
		kind: "refused",
		code: `HOBO_${fam}_ONEPASSWORD_${code}`,
		message,
		remediation,
	});
	const readyServiceAccount = async (
		value: string,
	): Promise<OnePasswordAccess> => {
		const token = parseOnePasswordServiceAccountToken(value);
		if (token === undefined)
			return refused(
				"SERVICE_ACCOUNT",
				"The 1Password service account is invalid, expired, or not scoped only to the configured vault.",
				[
					"Use a valid, unexpired service account scoped only to the configured vault.",
				],
			);
		const verdict = await options
			.validateServiceAccount(token, options.vaultId)
			.catch((): OnePasswordServiceAccountVerdict => "unverifiable");
		if (verdict !== true)
			return verdict === "unverifiable"
				? refused(
						"SERVICE_ACCOUNT_UNREACHABLE",
						"HoBo could not reach 1Password to check the service account.",
						[
							"Check that this run reaches 1Password through its required egress proxy and CA bundle, then run again.",
						],
					)
				: refused(
						"SERVICE_ACCOUNT",
						"The 1Password service account is invalid, expired, or not scoped only to the configured vault.",
						[
							"Use a valid, unexpired service account scoped only to the configured vault.",
						],
					);
		return {
			kind: "ready",
			token,
			expiresAt: new Date(
				(options.now ?? Date.now)() + ONE_PASSWORD_SERVICE_ACCOUNT_REUSE_MS,
			).toISOString(),
		};
	};
	const cli = onePasswordCli(options.platform ?? currentPlatform());
	const exists = options.exists ?? existsSync;
	const remote = !options.interactive;
	if (remote) {
		if (options.owner === undefined)
			return refused(
				"SIGN_IN",
				"1Password needs a private owner sign-in for this session.",
				[
					"Run through the HoBo MCP server to connect an existing 1Password service account in the private owner form.",
				],
			);
		const given = await captureAll(options.owner, [
			{
				name: ONE_PASSWORD_SERVICE_ACCOUNT_CAPTURE,
				title: "existing 1Password token",
				instructions:
					"Use an existing vault-scoped service account for this session.",
			},
		]).catch(() => undefined);
		const token = given?.[0];
		if (!token)
			return refused(
				"SIGN_IN",
				"1Password needs an existing service account for this session.",
				[
					ownerCaptureLine(
						ONE_PASSWORD_SERVICE_ACCOUNT_CAPTURE,
						"https://www.1password.dev/service-accounts/security",
					),
					"Use the private owner form to connect an existing service account.",
				],
			);
		return readyServiceAccount(token);
	}
	const run = options.run;
	if (run === undefined)
		return refused("CLI_INSTALL", "The 1Password CLI runner is unavailable.", [
			"Retry with a working local 1Password CLI integration.",
		]);
	let op: string;
	try {
		op = (
			await ensureStoreCli(cli, {
				run,
				which: options.which,
				toolsDir: options.toolsDir,
				exists,
			})
		).command;
	} catch (error) {
		if (!(error instanceof StoreCliInstallError)) throw error;
		return refused("CLI_INSTALL", error.message, [
			"Run again: HoBo installs the 1Password CLI into its own tools directory.",
		]);
	}
	const signedIn = async () => (await run(op, ["whoami"])).code === 0;
	if (await signedIn()) return createServiceAccount(op, run);
	options.emit("Signing in to 1Password: approve it in your 1Password app.");
	const signin = await run(op, ["signin"], { interactive: true });
	if (signin.code !== 0 || !(await signedIn()))
		return refused("SIGN_IN", "Signing in to 1Password did not complete.", [
			"Run again and approve the sign-in in your 1Password app.",
		]);
	return createServiceAccount(op, run);

	async function createServiceAccount(
		op: string,
		execute: RunCommand,
	): Promise<OnePasswordAccess> {
		const account = await execute(op, [
			"service-account",
			"create",
			`hobo-${options.family}`,
			"--vault",
			`${options.vaultId}:read_items,write_items`,
			"--expires-in",
			"24h",
			"--raw",
		]);
		if (account.code !== 0)
			return refused(
				"SERVICE_ACCOUNT",
				"1Password did not create HoBo's service account.",
				[
					"Your 1Password account needs permission to create service accounts (a team or business account).",
				],
			);
		return readyServiceAccount(account.stdout.trim());
	}
}
