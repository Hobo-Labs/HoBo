import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ciBudgetPolicy } from "@hobo/ci";
import {
	applyCiEnvironmentPolicy,
	type CiPolicyApplyOptions,
	ciEnvironmentPolicySha256,
	ciEnvironmentSecretsSha256,
	parseCiProjectConfig,
	requiredCiSecrets,
	selectCiEnvironment,
} from "./project-config.js";
import {
	createCiSecretDirectoryResolver,
	resolveCiSecrets,
} from "./project-secrets.js";

const maxConfigBytes = 256 * 1024;

async function readBoundedFile(path: string, limit: number): Promise<string> {
	const file = await open(path, "r");
	try {
		const details = await file.stat();
		if (!details.isFile() || details.size > limit)
			throw new Error("invalid bounded file");
		const buffer = Buffer.alloc(limit + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await file.read(buffer, size, buffer.length - size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > limit) throw new Error("bounded file exceeds size limit");
		return buffer.subarray(0, size).toString("utf8");
	} finally {
		await file.close();
	}
}

function readConfigFile(path: string, cwd: string): Promise<string> {
	return readBoundedFile(resolve(cwd, path), maxConfigBytes);
}

/** Run against an explicitly selected repository-local configuration. */
export async function runCiProjectCli(
	args: string[],
	options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		fetch?: typeof fetch;
		write?: (text: string) => void;
	} = {},
): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			config: { type: "string", default: ".hobo/ci.json" },
			"organization-config": { type: "string" },
			environment: { type: "string" },
			"trusted-origin": { type: "string" },
			"trusted-account": { type: "string" },
			"trusted-policy-sha256": { type: "string" },
			"token-file": { type: "string" },
			phase: { type: "string" },
			"secret-dir": { type: "string" },
			"allow-secret": { type: "string", multiple: true },
			"trusted-secrets-sha256": { type: "string" },
		},
	});
	if (
		positionals.length !== 1 ||
		(positionals[0] !== "inspect" &&
			positionals[0] !== "apply" &&
			positionals[0] !== "check-secrets")
	)
		throw new Error("expected inspect, apply, or check-secrets");
	const env = options.env ?? process.env;
	const initialDirectory = env.INIT_CWD || undefined;
	if (
		options.cwd === undefined &&
		initialDirectory &&
		(!isAbsolute(initialDirectory) ||
			initialDirectory.length > 4096 ||
			initialDirectory.includes("\0"))
	)
		throw new Error("invalid initial working directory");
	const cwd = options.cwd ?? initialDirectory ?? process.cwd();
	const organization = values["organization-config"]
		? parseCiProjectConfig(
				await readConfigFile(values["organization-config"], cwd),
			)
		: undefined;
	const config = parseCiProjectConfig(
		await readConfigFile(values.config, cwd),
		organization,
	);
	const selected = selectCiEnvironment(config, values.environment);
	const write = options.write ?? ((text: string) => process.stdout.write(text));
	if (positionals[0] === "inspect") {
		if (
			values["token-file"] ||
			values["trusted-origin"] ||
			values["trusted-account"] ||
			values["trusted-policy-sha256"] ||
			values.phase ||
			values["secret-dir"] ||
			values["allow-secret"] ||
			values["trusted-secrets-sha256"]
		)
			throw new Error("inspect does not accept credentials or trusted origins");
		write(
			`${JSON.stringify({
				environment: selected.name,
				relayOrigin: selected.relayOrigin,
				githubWebhookOrigin: selected.githubWebhookOrigin,
				accountId: selected.policy.accountId,
				budgetMicros: Math.min(
					selected.policy.budget?.limitMicros ?? 0,
					ciBudgetPolicy(selected.policy)?.limitMicros ??
						Number.MAX_SAFE_INTEGER,
				),
				policySha256: await ciEnvironmentPolicySha256(config, selected.name),
				secretsSha256: await ciEnvironmentSecretsSha256(config, selected.name),
			})}\n`,
		);
		return;
	}
	if (positionals[0] === "check-secrets") {
		if (
			!values.environment ||
			(values.phase !== "deployment" && values.phase !== "execution") ||
			!values["secret-dir"] ||
			!values["trusted-secrets-sha256"] ||
			!values["trusted-origin"] ||
			!values["trusted-account"] ||
			values["token-file"] ||
			values["trusted-policy-sha256"]
		)
			throw new Error(
				"check-secrets requires an explicit environment, phase, secret directory, and trusted digest",
			);
		if (
			selected.relayOrigin !== values["trusted-origin"] ||
			selected.policy.accountId !== values["trusted-account"]
		)
			throw new Error("CI relay environment binding is not trusted");
		const digest = await ciEnvironmentSecretsSha256(config, values.environment);
		if (digest !== values["trusted-secrets-sha256"])
			throw new Error("untrusted secret requirements");
		const names = requiredCiSecrets(config, values.environment, values.phase);
		await resolveCiSecrets(
			names,
			values["allow-secret"] ?? [],
			createCiSecretDirectoryResolver(values["secret-dir"]),
		);
		write(
			`${JSON.stringify({ environment: selected.name, phase: values.phase, checked: names })}\n`,
		);
		return;
	}
	if (
		values.phase ||
		values["secret-dir"] ||
		values["allow-secret"] ||
		values["trusted-secrets-sha256"]
	)
		throw new Error("apply does not accept secret preflight options");
	if (
		!values.environment ||
		!values["trusted-origin"] ||
		!values["trusted-account"] ||
		!values["trusted-policy-sha256"]
	)
		throw new Error(
			"apply requires an explicit environment and trusted target",
		);
	const trustedTargets = [
		{
			environment: values.environment,
			origin: values["trusted-origin"],
			accountId: values["trusted-account"],
		},
	];
	const tokenFile = values["token-file"] ?? env.HOBO_CI_ACCOUNT_TOKEN_FILE;
	if (tokenFile && env.HOBO_CI_ACCOUNT_TOKEN)
		throw new Error("choose exactly one account credential source");
	const accountToken = async () => {
		if (tokenFile) {
			const path = resolve(cwd, tokenFile);
			return (await readBoundedFile(path, 1024)).trimEnd();
		}
		return env.HOBO_CI_ACCOUNT_TOKEN ?? "";
	};
	const clientOptions: CiPolicyApplyOptions = {
		trustedTargets,
		accountToken,
		expectedPolicySha256: values["trusted-policy-sha256"],
	};
	if (options.fetch) clientOptions.fetch = options.fetch;
	const applied = await applyCiEnvironmentPolicy(
		config,
		values.environment,
		clientOptions,
	);
	write(
		`${JSON.stringify({
			environment: selected.name,
			relayOrigin: selected.relayOrigin,
			accountId: selected.policy.accountId,
			revision: applied.revision,
		})}\n`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runCiProjectCli(process.argv.slice(2)).catch(() => {
		process.stderr.write(
			"HoBo CI project command failed. Check the selected profile, trusted origin, credentials, and relay policy.\n",
		);
		process.exitCode = 1;
	});
}
