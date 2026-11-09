import { spawn } from "node:child_process";
import {
	CiRelayClientError,
	type createCiRelayClient,
} from "@hobo/ci-gh-actions/client";
import type { CommandResult } from "@hobo/cli";
import { z } from "zod";
import { type JsonValue, parseJsonValue } from "./json.js";

const Authorization = z.object({ authorizeUrl: z.string().max(4096) });
const DeviceCode = z.object({
	device_code: z.string().min(1).max(1024),
	user_code: z.string().regex(/^[A-Z0-9-]{4,32}$/),
	verification_uri: z.literal("https://github.com/login/device"),
	expires_in: z.number().int().positive().max(1800),
	interval: z.number().int().min(1).max(60).optional(),
});
const DeviceResponse = z.object({
	error: z.string().max(100).optional(),
	access_token: z.string().min(1).max(4096).optional(),
	token_type: z.string().max(40).optional(),
	interval: z.number().int().min(1).max(120).optional(),
});

type Failure = { ok: false; code: string; message: string };
const failed = (code: string, message: string): Failure => ({
	ok: false,
	code,
	message,
});

/** Read small responses without allowing a remote server to fill the CLI's memory. */
async function json(response: Response): Promise<JsonValue> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("empty response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > 16_384) {
				void reader.cancel().catch(() => undefined);
				throw new Error("response too large");
			}
			chunks.push(part.value);
		}
		return parseJsonValue(Buffer.concat(chunks).toString("utf8"));
	} finally {
		reader.releaseLock();
	}
}

function openBrowser(url: string): void {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/i.test(name),
		),
	);
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "rundll32"
				: "xdg-open";
	const args =
		process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
	try {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			env,
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// The URL is also shown to the user for headless systems.
	}
}

/**
 * The hosted relay owns manifest conversion and the App vault. The CLI observes
 * its authenticated API and never receives an App key or browser session cookie.
 */
export async function runGithubCeremony(input: {
	origin: string;
	credential: string;
	client: ReturnType<typeof createCiRelayClient>;
	prompt: (question: string) => Promise<string>;
	emitProgress: (message: string) => void;
	fetch?: typeof fetch | undefined;
	openBrowser?: ((url: string) => void) | undefined;
	sleep?: ((ms: number) => Promise<void>) | undefined;
	now?: (() => number) | undefined;
}): Promise<CommandResult> {
	const send = input.fetch ?? fetch;
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = input.now ?? Date.now;
	const open = input.openBrowser ?? openBrowser;
	const show = (url: string, message: string) => {
		input.emitProgress(`${message}\n${url}`);
		open(url);
	};
	const request = (url: string, init: RequestInit) =>
		send(url, {
			...init,
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
	async function clientId(): Promise<{ value?: string; status: number }> {
		const response = await request(
			`${input.origin}/v1/app-registration/oauth/start`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${input.credential}`,
					accept: "application/json",
				},
			},
		);
		if (!response.ok) return { status: response.status };
		const { authorizeUrl } = Authorization.parse(await json(response));
		const url = new URL(authorizeUrl);
		const ids = url.searchParams.getAll("client_id");
		if (
			url.origin !== "https://github.com" ||
			url.pathname !== "/login/oauth/authorize" ||
			url.username ||
			url.password ||
			url.hash ||
			ids.length !== 1 ||
			!/^[A-Za-z0-9_.-]{1,200}$/.test(ids[0] ?? "")
		)
			throw new Error("invalid authorization response");
		return { value: ids[0] ?? "", status: response.status };
	}
	try {
		let app = await clientId();
		let openedRegistration = false;
		if (app.status === 503) {
			const answer = await input.prompt(
				"The relay is not ready for GitHub authorization. Open App registration? [y/N] ",
			);
			if (!/^y(?:es)?$/i.test(answer.trim()))
				return failed(
					"HOBO_CI_GITHUB_NOT_READY",
					"GitHub App setup was not started. Check the relay and retry.",
				);
			show(
				`${input.origin}/v1/app-bootstrap/setup`,
				"Complete the prefilled GitHub App registration in your browser. If an owner invitation is required, open the operator's invitation link in the same browser. The relay stores the generated keys in its encrypted vault.",
			);
			openedRegistration = true;
			const deadline = now() + 10 * 60_000;
			input.emitProgress(
				"Waiting for the relay to finish App registration and owner verification…",
			);
			while (now() < deadline) {
				await sleep(5_000);
				app = await clientId();
				if (app.status !== 503) break;
			}
		}
		if (!app.value) {
			if (app.status === 401 || app.status === 403)
				return failed(
					"HOBO_CI_GITHUB_AUTH",
					"The relay rejected the CI account credential or its repositories:write scope.",
				);
			return failed(
				"HOBO_CI_GITHUB_NOT_READY",
				"The relay has not confirmed GitHub App registration. Check the browser and relay; reconcile an uncertain registration before trying to create another App.",
			);
		}
		if (openedRegistration) {
			show(
				"https://github.com/settings/apps",
				"Open the new HoBo CI App settings, enable Device Flow under Identifying and authorizing users, and save. For an organization-owned App, use its organization settings.",
			);
			await input.prompt(
				"Press Enter after saving the setting (or Ctrl-C to cancel): ",
			);
		}

		// GitHub's manifest has no device-flow setting. Verify the setting by
		// completing the documented device grant; never retain its user token.
		let authorized = false;
		for (let attempt = 0; attempt < 3 && !authorized; attempt++) {
			const codeResponse = await request(
				"https://github.com/login/device/code",
				{
					method: "POST",
					headers: {
						accept: "application/json",
						"content-type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						client_id: app.value,
						scope: "offline_access",
					}),
				},
			);
			const codeBody = await json(codeResponse);
			const code = DeviceCode.safeParse(codeBody);
			const deviceError = DeviceResponse.safeParse(codeBody);
			let disabled =
				deviceError.success &&
				deviceError.data.error === "device_flow_disabled";
			if (codeResponse.ok && code.success) {
				show(
					code.data.verification_uri,
					`Enter this GitHub device code: ${code.data.user_code}`,
				);
				let interval = (code.data.interval ?? 5) * 1000;
				const deadline = now() + code.data.expires_in * 1000;
				while (now() + interval < deadline) {
					await sleep(interval);
					if (now() >= deadline) break;
					const response = await request(
						"https://github.com/login/oauth/access_token",
						{
							method: "POST",
							headers: {
								accept: "application/json",
								"content-type": "application/x-www-form-urlencoded",
							},
							body: new URLSearchParams({
								client_id: app.value,
								device_code: code.data.device_code,
								grant_type: "urn:ietf:params:oauth:grant-type:device_code",
							}),
						},
					);
					const result = DeviceResponse.parse(await json(response));
					if (
						response.ok &&
						result.access_token &&
						result.token_type?.toLowerCase() === "bearer"
					) {
						authorized = true;
						break;
					}
					if (result.error === "authorization_pending") continue;
					if (result.error === "slow_down") {
						interval = Math.max(
							interval + 5_000,
							(result.interval ?? 0) * 1000,
						);
						continue;
					}
					if (result.error === "device_flow_disabled") disabled = true;
					else
						return failed(
							"HOBO_CI_GITHUB_DEVICE",
							"GitHub device authorization was denied, expired, or failed. Retry the connection.",
						);
					break;
				}
				if (!authorized && !disabled)
					return failed(
						"HOBO_CI_GITHUB_DEVICE",
						"GitHub device authorization expired. Retry the connection.",
					);
			} else if (!disabled) {
				return failed(
					"HOBO_CI_GITHUB_DEVICE",
					"GitHub did not start device authorization. Check the App settings and retry.",
				);
			}
			if (disabled) {
				show(
					"https://github.com/settings/apps",
					"Open the HoBo CI App settings, enable Device Flow under Identifying and authorizing users, and save. For an organization-owned App, use its organization settings.",
				);
				await input.prompt(
					"Press Enter after saving the setting (or Ctrl-C to cancel): ",
				);
			}
		}
		if (!authorized)
			return failed(
				"HOBO_CI_GITHUB_DEVICE",
				"GitHub has not confirmed device flow. Check the App settings and retry.",
			);
		input.emitProgress(
			"GitHub device authorization confirmed. The temporary user token was not saved.",
		);

		let installations = await input.client.getInstallations();
		let install = installations.installationIds.length === 0;
		if (!install) {
			const answer = await input.prompt(
				"Install or update the App for another organization or repository? [y/N] ",
			);
			install = /^y(?:es)?$/i.test(answer.trim());
		}
		if (install) {
			show(
				`${input.origin}/v1/app-registration/setup`,
				"Connect your GitHub account and install or update the App for the repositories you want. Complete both buttons on the relay page.",
			);
			if (installations.installationIds.length) {
				await input.prompt(
					"Press Enter after completing the installation or update: ",
				);
				installations = await input.client.getInstallations();
			} else {
				const deadline = now() + 10 * 60_000;
				input.emitProgress(
					"Waiting for the relay to verify and bind the installation…",
				);
				while (!installations.installationIds.length && now() < deadline) {
					await sleep(5_000);
					installations = await input.client.getInstallations();
				}
			}
		}
		if (!installations.installationIds.length)
			return failed(
				"HOBO_CI_INSTALL_REQUIRED",
				"The relay has not confirmed an authorized GitHub App installation. Complete the browser setup and retry.",
			);
		return { ok: true };
	} catch (error) {
		if (
			error instanceof CiRelayClientError &&
			(error.status === 401 || error.status === 403)
		)
			return failed(
				"HOBO_CI_GITHUB_AUTH",
				"The relay rejected the CI account credential or installation authorization.",
			);
		return failed(
			"HOBO_CI_GITHUB_SETUP",
			"GitHub setup could not be confirmed. Check network access and the relay, then retry. If registration was uncertain, reconcile it before creating another App.",
		);
	}
}
