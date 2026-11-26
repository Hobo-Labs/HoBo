/**
 * APPISH — docker-push-to-URL competitor (appi.sh).
 * Free slots: docs require dashboard push-id (login). Crane anon push historically
 * fails with BLOB_UPLOAD_INVALID. Adapter is one-shot + fail-closed — never loops.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
	AnonContainerHostError,
	type AnonContainerDeployInput,
	type AnonContainerHostResult,
} from "./types.mts";

export const APPISH_REGISTRY = "push.to.appi.sh";
export const APPISH_TIMEOUT_MS = 120_000;

export type ProvisionAppishInput = AnonContainerDeployInput & {
	/** Public OCI image to copy (linux/amd64). */
	readonly sourceImage: string;
	readonly craneBin?: string;
};

function run(
	command: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({
				code: 124,
				stdout,
				stderr: `${stderr}\ntimeout after ${timeoutMs}ms`,
			});
		}, timeoutMs);
		child.stdout?.on("data", (c) => {
			stdout += String(c);
		});
		child.stderr?.on("data", (c) => {
			stderr += String(c);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: 1, stdout: "", stderr: error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

export async function provisionAppishCrane(
	input: ProvisionAppishInput,
): Promise<AnonContainerHostResult> {
	const slot = `hobo${randomBytes(3).toString("hex")}`;
	const port = input.port ?? 80;
	const dest = `${APPISH_REGISTRY}/${slot}/app:port_${port}`;

	if (input.mock) {
		return {
			ok: true,
			host: "appish-crane",
			url: `https://${slot}.appi.sh`,
			kind: "oci-image",
			anonymous: true,
			temporary: true,
			mocked: true,
			detail: `mock crane copy → ${dest}`,
		};
	}

	const crane = input.craneBin ?? process.env.HOBO_CRANE_BIN?.trim() ?? "crane";
	const copy = await run(
		crane,
		[
			"copy",
			"--platform",
			"linux/amd64",
			input.sourceImage,
			dest,
		],
		APPISH_TIMEOUT_MS,
	);
	if (copy.code !== 0) {
		throw new AnonContainerHostError(
			"appish-crane",
			`APPISH crane copy failed (one-shot). Docs require dashboard push-id/login. ` +
				`stderr: ${(copy.stderr || copy.stdout).slice(0, 400)}`,
		);
	}

	const url = `https://${slot}.appi.sh`;
	const fetchImpl = input.fetchImpl ?? fetch;
	const probe = await fetchImpl(url, {
		method: "GET",
		signal: AbortSignal.timeout(15_000),
	}).catch(() => null);
	if (!probe || probe.status >= 500 || probe.status === 404) {
		throw new AnonContainerHostError(
			"appish-crane",
			`APPISH push reported OK but live URL not healthy (HTTP ${probe?.status ?? "network"}). ` +
				"Free slots are login-gated per appi.sh/docs — fail closed.",
			probe?.status,
		);
	}

	return {
		ok: true,
		host: "appish-crane",
		url,
		kind: "oci-image",
		anonymous: true,
		temporary: true,
		detail: `crane copy ${input.sourceImage} → ${dest}`,
	};
}
