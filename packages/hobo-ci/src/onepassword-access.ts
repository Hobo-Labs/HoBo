import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	captureAll,
	type OwnerChannel,
	ownerCaptureLine,
} from "./owner-channel.js";
import {
	type CommandEnv,
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
	/** How to reach an owner who is not at this machine (a remote dev box). */
	readonly owner?: OwnerChannel;
	/** The account's sign-in address; 1Password's US cloud by default. */
	readonly signInAddress?: string;
	/** Where a remote sign-in keeps its throwaway CLI config (tests). */
	readonly tempDir?: () => Promise<string>;
}

// public-contract: the capture names a remote 1Password sign-in hands to the waiting run.
export const ONE_PASSWORD_SIGN_IN_CAPTURES = [
	"ONEPASSWORD_EMAIL",
	"ONEPASSWORD_SECRET_KEY",
	"ONEPASSWORD_PASSWORD",
] as const;

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
	const remote = !options.interactive;
	if (remote && options.owner === undefined)
		return refused(
			"SIGN_IN",
			"1Password needs you to sign in once, and this run has no way to reach you for it.",
			[
				"Run hobo up through the HoBo MCP server (its cd and ci tools): its secret form takes your 1Password sign-in straight to this run.",
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
	if (await signedIn()) return createServiceAccount(op, []);
	if (!remote) {
		options.emit("Signing in to 1Password: approve it in your 1Password app.");
		const signin = await options.run(op, ["signin"], { interactive: true });
		if (signin.code !== 0 || !(await signedIn()))
			return refused("SIGN_IN", "Signing in to 1Password did not complete.", [
				"Run again and approve the sign-in in your 1Password app.",
			]);
		return createServiceAccount(op, []);
	}
	// A remote box: no 1Password app here to approve a sign-in. The owner
	// hands their sign-in to this run through the HoBo MCP App's secret
	// form; the CLI signs in with it in a throwaway configuration, HoBo
	// creates its own service account, and the configuration is deleted.
	const address = options.signInAddress ?? "my.1password.com";
	const guide = `https://${address}/profile`;
	const askAgain = (message: string) =>
		refused("SIGN_IN", message, [
			...ONE_PASSWORD_SIGN_IN_CAPTURES.map((name) =>
				ownerCaptureLine(name, guide),
			),
			`Hand over your 1Password sign-in for ${address} in the HoBo MCP App's secret form: your email, your Secret Key (in your 1Password app: your account → Secret Key, or your Emergency Kit) and your password. They go only to this run, which uses them once and keeps nothing.`,
			"Then run again: HoBo creates its own service account for the vault.",
		]);
	const owner = options.owner;
	const given =
		owner === undefined
			? undefined
			: await captureAll(owner, [
					{
						name: "ONEPASSWORD_EMAIL",
						title: "1Password email",
						instructions: `The email you sign in to ${address} with.`,
					},
					{
						name: "ONEPASSWORD_SECRET_KEY",
						title: "1Password Secret Key",
						instructions:
							"Your Secret Key (A3-…): in your 1Password app, your account details, or your Emergency Kit.",
					},
					{
						name: "ONEPASSWORD_PASSWORD",
						title: "1Password password",
						instructions: "Your 1Password account password.",
					},
				]);
	if (given === undefined)
		return askAgain(
			"1Password needs you to sign in once; from a remote box there is no 1Password app here to approve it.",
		);
	const [email = "", secretKey = "", password = ""] = given;
	const configDir = await (
		options.tempDir ?? (() => mkdtemp(path.join(tmpdir(), "hobo-op-")))
	)();
	try {
		const config: CommandEnv = [["OP_CONFIG_DIR", configDir]];
		const added = await options.run(
			op,
			[
				"account",
				"add",
				"--address",
				address,
				"--email",
				email,
				"--shorthand",
				"hobo",
				"--signin",
				"--raw",
			],
			{
				env: [...config, ["OP_SECRET_KEY", secretKey]],
				input: `${password}\n`,
			},
		);
		const session = added.stdout.trim();
		if (added.code !== 0 || session === "")
			return askAgain(
				"1Password did not accept that sign-in. Check the email, Secret Key and password (an account with two-step verification also needs its one-time code, which this sign-in cannot take).",
			);
		return await createServiceAccount(op, [
			...config,
			["OP_SESSION_hobo", session],
		]);
	} finally {
		await rm(configDir, { recursive: true, force: true });
	}

	async function createServiceAccount(
		op: string,
		env: CommandEnv,
	): Promise<OnePasswordAccess> {
		const account = await options.run(
			op,
			[
				"service-account",
				"create",
				`hobo-${options.family}`,
				"--vault",
				`${options.vaultId}:read_items,write_items`,
				"--expires-in",
				"24h",
				"--raw",
				...(env.length > 0 ? ["--account", "hobo"] : []),
			],
			env.length > 0 ? { env } : undefined,
		);
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
}
