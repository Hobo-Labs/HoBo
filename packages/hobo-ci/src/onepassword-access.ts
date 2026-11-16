import { existsSync } from "node:fs";
import path from "node:path";

import {
	ensureStoreCli,
	type RunCommand,
	type StoreCli,
	StoreCliInstallError,
} from "./store-cli.js";

/**
 * Connect 1Password with as little manual provisioning as 1Password allows.
 *
 * 1. Its CLI (`op`): found on the machine, else installed from 1Password's
 *    official download into HoBo's tools directory.
 * 2. A session: an existing `op` session is used as it is; otherwise the
 *    owner signs in once with `op signin`, which their 1Password app
 *    approves.
 * 3. HoBo's own service account, created with the CLI: scoped to the one
 *    vault (read and write), expiring in a day. 1Password has no OIDC sign-in
 *    for service accounts (its Credential Broker serves CI workloads), so a
 *    short-lived, vault-scoped account is the least standing credential.
 */

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

export interface OnePasswordAccessOptions {
	readonly family: "ci" | "cd";
	readonly vaultId: string;
	readonly run: RunCommand;
	readonly which: (bin: string) => Promise<string | undefined>;
	readonly toolsDir: string;
	readonly emit: (line: string) => void;
	/** The owner is at this machine: their 1Password app can approve a sign-in. */
	readonly interactive: boolean;
	readonly platform?: Platform;
	readonly exists?: (file: string) => boolean;
}

export type OnePasswordAccess =
	| { readonly kind: "ready"; readonly token: string }
	| {
			readonly kind: "refused";
			readonly code: string;
			readonly message: string;
			readonly remediation: readonly string[];
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
	const cli = onePasswordCli(options.platform ?? currentPlatform());
	const exists = options.exists ?? existsSync;
	if (
		!options.interactive &&
		(await options.which(cli.bin)) === undefined &&
		!exists(cli.installedPath(options.toolsDir))
	)
		return refused(
			"SIGN_IN",
			"1Password needs you to sign in once, and your 1Password app approves sign-ins on the machine it runs on.",
			[
				"Run hobo up on your own machine once: HoBo installs the 1Password CLI, your 1Password app approves the sign-in, and HoBo sets up the rest.",
			],
		);
	let op: string;
	try {
		op = (
			await ensureStoreCli(cli, {
				run: options.run,
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
	const signedIn = async () => (await options.run(op, ["whoami"])).code === 0;
	if (!(await signedIn())) {
		if (!options.interactive)
			return refused(
				"SIGN_IN",
				"1Password needs you to sign in once, and your 1Password app approves sign-ins on the machine it runs on.",
				[
					"Run hobo up on your own machine once: your 1Password app approves the sign-in, and HoBo sets up the rest.",
				],
			);
		options.emit("Signing in to 1Password: approve it in your 1Password app.");
		const signin = await options.run(op, ["signin"], { interactive: true });
		if (signin.code !== 0 || !(await signedIn()))
			return refused("SIGN_IN", "Signing in to 1Password did not complete.", [
				"Run again and approve the sign-in in your 1Password app.",
			]);
	}
	const account = await options.run(op, [
		"service-account",
		"create",
		`hobo-${options.family}`,
		"--vault",
		`${options.vaultId}:read_items,write_items`,
		"--expires-in",
		"24h",
		"--raw",
	]);
	const token = account.stdout.trim();
	if (account.code !== 0 || token === "")
		return refused(
			"SERVICE_ACCOUNT",
			"1Password did not create HoBo's service account.",
			[
				"Your 1Password account needs permission to create service accounts (a team or business account).",
			],
		);
	return { kind: "ready", token };
}
