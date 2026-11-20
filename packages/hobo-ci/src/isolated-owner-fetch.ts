import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { egressFrom } from "./egress.js";
import {
	PrivateOwnerDispatchError,
	PrivateOwnerRequestError,
} from "./isolated-owner-errors.js";
import {
	OWNER_BODY_LIMIT,
	OWNER_MESSAGE_LIMIT,
	ownerRequest,
	ownerResponse,
} from "./isolated-owner-wire.js";

export interface PrivateOwnerChild {
	readonly stdin: {
		once(event: "error", listener: () => void): void;
		end(value: string): void;
	};
	readonly stdout: {
		once(event: "error", listener: () => void): void;
		on(event: "data", listener: (chunk: Buffer) => void): void;
	};
	once(event: "spawn", listener: () => void): void;
	once(event: "error", listener: () => void): void;
	once(event: "close", listener: (code: number | null) => void): void;
	kill(signal: "SIGKILL"): void;
}

export type PrivateOwnerChildLauncher = (input: {
	readonly executable: string;
	readonly childPath: string;
	readonly env: Readonly<Record<string, string>>;
}) => PrivateOwnerChild;

const launchOwnerChild: PrivateOwnerChildLauncher = (input) =>
	spawn(input.executable, [input.childPath], {
		env: input.env,
		stdio: ["pipe", "pipe", "ignore"],
		windowsHide: true,
	});

class IsolatedOwnerResponse extends Response {
	readonly #responseUrl: string;
	readonly #wasRedirected: boolean;
	readonly #responseType: ResponseType;

	constructor(
		body: BodyInit | null,
		init: ResponseInit,
		metadata: {
			url: string;
			redirected: boolean;
			type: ResponseType;
		},
	) {
		super(body, init);
		this.#responseUrl = metadata.url;
		this.#wasRedirected = metadata.redirected;
		this.#responseType = metadata.type;
	}
	override get url(): string {
		return this.#responseUrl;
	}
	override get redirected(): boolean {
		return this.#wasRedirected;
	}
	override get type(): ResponseType {
		return this.#responseType;
	}
	override clone(): Response {
		const copy = super.clone();
		return new IsolatedOwnerResponse(
			copy.body,
			{
				status: copy.status,
				statusText: copy.statusText,
				headers: copy.headers,
			},
			{ url: this.url, redirected: this.redirected, type: this.type },
		);
	}
}

async function requestBody(request: Request): Promise<string | null> {
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const cancel = () => {
		void reader.cancel().catch(() => undefined);
	};
	request.signal.addEventListener("abort", cancel, { once: true });
	try {
		if (request.signal.aborted) cancel();
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > OWNER_BODY_LIMIT) {
				cancel();
				throw new PrivateOwnerRequestError();
			}
			chunks.push(part.value);
		}
	} finally {
		request.signal.removeEventListener("abort", cancel);
	}
	return Buffer.concat(chunks).toString("base64");
}

export function isolatedOwnerFetch(
	env: Readonly<Record<string, string | undefined>>,
): typeof fetch {
	return createIsolatedOwnerFetch(env, launchOwnerChild);
}

export function createIsolatedOwnerFetch(
	env: Readonly<Record<string, string | undefined>>,
	launchChild: PrivateOwnerChildLauncher,
): typeof fetch {
	const egress = egressFrom(env);
	const childPath = fileURLToPath(
		new URL("../dist/isolated-owner-fetch-child.js", import.meta.url),
	);
	return async (input, init) => {
		let request: Request;
		let body: string | null;
		try {
			request = new Request(input, init);
			body = await requestBody(request);
		} catch {
			throw new PrivateOwnerRequestError();
		}
		if (request.signal.aborted)
			throw new DOMException("The request was cancelled.", "AbortError");
		const packet = ownerRequest.safeParse({
			url: request.url,
			method: request.method,
			headers: [...request.headers.entries()],
			redirect: request.redirect,
			cache: request.cache,
			credentials: request.credentials,
			integrity: request.integrity,
			keepalive: request.keepalive,
			mode: request.mode,
			referrer: request.referrer,
			referrerPolicy: request.referrerPolicy,
			body,
			egress: {
				...(egress.proxy ? { proxy: egress.proxy } : undefined),
				...(egress.noProxy ? { noProxy: egress.noProxy } : undefined),
				...(egress.caFile ? { caFile: egress.caFile } : undefined),
			},
		});
		if (!packet.success) throw new PrivateOwnerRequestError();
		const encoded = JSON.stringify(packet.data);
		if (Buffer.byteLength(encoded) > OWNER_MESSAGE_LIMIT)
			throw new PrivateOwnerRequestError();
		return new Promise<Response>((resolve, reject) => {
			const childEnv =
				process.platform === "win32" && process.env.SystemRoot
					? { SystemRoot: process.env.SystemRoot }
					: {};
			const launch = () =>
				launchChild({
					executable: process.execPath,
					childPath,
					env: childEnv,
				});
			let child: ReturnType<typeof launch>;
			try {
				child = launch();
			} catch {
				reject(new PrivateOwnerRequestError());
				return;
			}
			let settled = false;
			let spawned = false;
			let size = 0;
			const chunks: Buffer[] = [];
			const finish = (response?: Response, preDispatch = false) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				request.signal.removeEventListener("abort", cancel);
				if (response) resolve(response);
				else
					reject(
						preDispatch
							? new PrivateOwnerRequestError()
							: new PrivateOwnerDispatchError(),
					);
			};
			const cancel = () => {
				if (settled) return;
				finish();
				try {
					child.kill("SIGKILL");
				} catch {}
			};
			const timer = setTimeout(cancel, 120_000);
			child.once("spawn", () => {
				spawned = true;
			});
			child.once("error", () => finish(undefined, !spawned));
			child.stdin.once("error", cancel);
			child.stdout.once("error", cancel);
			child.stdout.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > OWNER_MESSAGE_LIMIT) {
					cancel();
					return;
				}
				chunks.push(chunk);
			});
			child.once("close", (code) => {
				if (code !== 0 || settled) {
					finish();
					return;
				}
				try {
					const parsed = ownerResponse.parse(
						JSON.parse(Buffer.concat(chunks).toString("utf8")),
					);
					if (!parsed.ok) {
						finish();
						return;
					}
					const bytes = Buffer.from(parsed.body, "base64");
					if (bytes.byteLength > OWNER_BODY_LIMIT) {
						finish();
						return;
					}
					const noBody =
						request.method === "HEAD" ||
						parsed.status === 204 ||
						parsed.status === 205 ||
						parsed.status === 304;
					finish(
						new IsolatedOwnerResponse(
							noBody ? null : new Uint8Array(bytes),
							{
								status: parsed.status,
								statusText: parsed.statusText,
								headers: parsed.headers,
							},
							{
								url: parsed.url,
								redirected: parsed.redirected,
								type: parsed.type,
							},
						),
					);
				} catch {
					finish();
				}
			});
			request.signal.addEventListener("abort", cancel, { once: true });
			if (request.signal.aborted) {
				cancel();
				return;
			}
			try {
				child.stdin.end(encoded);
			} catch {
				cancel();
			}
		});
	};
}
