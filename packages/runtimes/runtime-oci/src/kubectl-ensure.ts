/**
 * Ensure a kubectl client binary under HOBO_HOME (offline equip path).
 * Cluster reachability is separate — ensure makes the client equippable.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonString } from "./json.js";

// public-contract: pinned kubectl client for oci host ensure.
export const PINNED_KUBECTL_VERSION = "1.31.0" as const;

export type KubectlBinary = Readonly<{
	binPath: string;
	version: string;
	source: "env" | "tools" | "path" | "downloaded";
}>;

function toolsDir(hoboHome: string): string {
	return join(hoboHome, "tools");
}

function platformTriple(): string {
	const p = process.platform;
	const a = process.arch;
	const os = p === "darwin" ? "darwin" : p === "linux" ? "linux" : p;
	const arch = a === "x64" ? "amd64" : a === "arm64" ? "arm64" : a;
	return `${os}/${arch}`;
}

function tryKubectl(bin: string): { version: string } | null {
	const r = spawnSync(bin, ["version", "--client", "--output=json"], {
		encoding: "utf8",
		timeout: 15_000,
	});
	if (r.status !== 0) {
		// older clients
		const plain = spawnSync(bin, ["version", "--client"], {
			encoding: "utf8",
			timeout: 15_000,
		});
		if (plain.status !== 0) return null;
		const m = (plain.stdout || plain.stderr || "").match(
			/Client Version:\s*v?(\d+\.\d+\.\d+)/i,
		);
		return m?.[1] ? { version: m[1] } : { version: "0.0.0" };
	}
	try {
		// SAFETY: assertion required at this I/O or test boundary.
		const j = JSON.parse(r.stdout) as {
			clientVersion?: { gitVersion?: string };
		};
		const gv = j.clientVersion?.gitVersion?.replace(/^v/, "") ?? "0.0.0";
		return { version: gv };
	} catch {
		return { version: "0.0.0" };
	}
}

/**
 * Resolve kubectl meeting pinned floor, downloading into $HOBO_HOME/tools/kubectl.
 */
export async function ensureKubectlBinary(
	options: {
		readonly hoboHome: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly download?: boolean;
		readonly emitProgress?: (message: string) => void;
	} = { hoboHome: "" },
): Promise<KubectlBinary> {
	const env = options.env ?? process.env;
	const hoboHome = options.hoboHome || env.HOBO_HOME || join(tmpdir(), "hobo");
	const download = options.download ?? true;
	const emit = options.emitProgress ?? (() => {});

	const fromEnv = env.HOBO_KUBECTL_BIN;
	if (isJsonString(fromEnv) && fromEnv.length > 0) {
		const probed = tryKubectl(fromEnv);
		if (probed) {
			return { binPath: fromEnv, version: probed.version, source: "env" };
		}
	}

	const toolsPath = join(toolsDir(hoboHome), "kubectl");
	const toolsProbe = tryKubectl(toolsPath);
	if (toolsProbe) {
		return {
			binPath: toolsPath,
			version: toolsProbe.version,
			source: "tools",
		};
	}

	const pathProbe = tryKubectl("kubectl");
	if (pathProbe) {
		return { binPath: "kubectl", version: pathProbe.version, source: "path" };
	}

	if (!download) {
		throw new Error(
			`kubectl not found; run \`hobo yard ensure\` or set HOBO_KUBECTL_BIN`,
		);
	}

	const triple = platformTriple();
	if (!triple.startsWith("linux/") && !triple.startsWith("darwin/")) {
		throw new Error(
			`automatic kubectl download unsupported for ${triple}; install kubectl and set HOBO_KUBECTL_BIN`,
		);
	}

	const version = PINNED_KUBECTL_VERSION;
	const url = `https://dl.k8s.io/release/v${version}/bin/${triple}/kubectl`;
	const staging = join(
		tmpdir(),
		`hobo-kubectl-${version}-${process.pid}-${randomUUID()}`,
	);
	mkdirSync(staging, { recursive: true });
	const archivePath = join(staging, "kubectl");

	emit(
		`hobo: downloading kubectl ${version} (${triple}) into ${toolsDir(hoboHome)}`,
	);
	const curl = spawnSync("curl", ["-fsSL", "-o", archivePath, url], {
		encoding: "utf8",
		timeout: 120_000,
	});
	if (curl.status !== 0) {
		rmSync(staging, { recursive: true, force: true });
		throw new Error(
			`failed to download kubectl ${version} from ${url}: ${curl.stderr || curl.stdout}`,
		);
	}

	mkdirSync(toolsDir(hoboHome), { recursive: true });
	writeFileSync(toolsPath, readFileSync(archivePath));
	chmodSync(toolsPath, 0o755);
	rmSync(staging, { recursive: true, force: true });

	const verified = tryKubectl(toolsPath);
	if (!verified) {
		throw new Error(`downloaded kubectl at ${toolsPath} failed version probe`);
	}
	emit(`hobo: kubectl ${verified.version} ready at ${toolsPath}`);
	return {
		binPath: toolsPath,
		version: verified.version,
		source: "downloaded",
	};
}

export function kubectlToolsPath(hoboHome: string): string {
	return join(toolsDir(hoboHome), "kubectl");
}

export function isKubectlPresent(
	hoboHome: string,
	env?: NodeJS.ProcessEnv,
): boolean {
	const e = env ?? process.env;
	if (isJsonString(e.HOBO_KUBECTL_BIN) && existsSync(e.HOBO_KUBECTL_BIN)) {
		return true;
	}
	if (existsSync(kubectlToolsPath(hoboHome))) return true;
	const pathProbe = tryKubectl("kubectl");
	return pathProbe !== null;
}
