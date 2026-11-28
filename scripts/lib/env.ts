import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type CommandInvocation = {
	command: string;
	args: string[];
};

export function sanitizeNodeOptions(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return { ...env, NODE_OPTIONS: "" };
}

export function commandForPlatform(
	command: string,
	args: string[],
): CommandInvocation {
	if (process.platform === "win32" && command === "pnpm") {
		return {
			command: process.env.ComSpec ?? "cmd.exe",
			args: ["/d", "/c", "pnpm.cmd", ...args],
		};
	}

	return { command, args };
}

export type CheckoutFacts = {
	readonly root: string;
	readonly scripts: { readonly [name: string]: string };
	readonly platform: string;
	readonly hasBin: (name: string) => boolean;
};

function rootScripts(root: string): { readonly [name: string]: string } {
	try {
		const manifest: {
			readonly scripts?: { readonly [name: string]: string };
		} = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return manifest.scripts ?? {};
	} catch {
		return {};
	}
}

function checkoutFacts(root: string): CheckoutFacts {
	return {
		root,
		scripts: rootScripts(root),
		platform: process.platform,
		hasBin: (name) => existsSync(join(root, "node_modules", ".bin", name)),
	};
}

const PLAIN_BIN = /^[A-Za-z0-9_@][A-Za-z0-9_.+@-]*$/u;

export function withoutPackageManager(
	command: string,
	args: string[],
	facts: CheckoutFacts = checkoutFacts(process.cwd()),
): CommandInvocation {
	const unchanged = { command, args };
	if (command !== "pnpm" || facts.platform === "win32") return unchanged;
	const [verb, name, ...rest] = args;
	if (verb === "exec") {
		if (
			name === undefined ||
			!PLAIN_BIN.test(name) ||
			name.includes("..") ||
			name === "node"
		) {
			throw new Error(
				`pnpm exec ${args.slice(1).join(" ")}: only a plain binary name in node_modules/.bin runs without pnpm`,
			);
		}
		if (!facts.hasBin(name)) {
			throw new Error(
				`pnpm exec ${name}: node_modules/.bin/${name} is not installed; install dependencies first`,
			);
		}
		return {
			command: join(facts.root, "node_modules", ".bin", name),
			args: rest,
		};
	}
	if (verb !== "run" || name === undefined) return unchanged;
	const known = (script: string) => Object.hasOwn(facts.scripts, script);
	if (!known(name) || known(`pre${name}`) || known(`post${name}`)) {
		return unchanged;
	}
	const scriptArgs = rest[0] === "--" ? rest.slice(1) : rest;
	return {
		command: process.execPath,
		args: [
			"--experimental-strip-types",
			join(facts.root, "scripts", "run-script.mts"),
			name,
			"--",
			...scriptArgs,
		],
	};
}
