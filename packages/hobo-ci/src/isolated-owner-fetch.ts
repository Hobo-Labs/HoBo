import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { egressFrom } from "./egress.js";
import {
	PrivateOwnerDispatchError,
	PrivateOwnerRequestError,
} from "./isolated-owner-errors.js";
import {
	assertPrivateOwnerProxy,
	isolatedOwnerOrigin,
} from "./isolated-owner-origin.js";
import {
	OWNER_BODY_LIMIT,
	OWNER_DEFAULT_RESPONSE_LIMIT,
	OWNER_MESSAGE_LIMIT,
	ownerRequest,
	ownerResponse,
} from "./isolated-owner-wire.js";
import { defaultCaCertificates } from "./tls-trust.js";

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

export interface IsolatedOwnerFetchOptions {
	readonly maxResponseBytes?: number;
	readonly allowInsecureLoopback?: boolean;
}

const OWNER_PHASE_TIMEOUT_MS = 120_000;

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

async function requestBody(
	request: Request,
	deadline: number,
): Promise<string | null> {
	if (!request.body) return null;
	const reader = request.body.getReader();
	const chunks: Buffer[] = [];
	let chunk = Buffer.alloc(64 * 1024);
	let used = 0;
	let size = 0;
	let rejectStopped: () => void = () => undefined;
	const stopped = new Promise<never>((_resolve, reject) => {
		rejectStopped = () => reject(new PrivateOwnerRequestError());
	});
	let cancelled = false;
	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		rejectStopped();
		void reader.cancel().catch(() => undefined);
	};
	const timer = setTimeout(cancel, Math.max(0, deadline - performance.now()));
	request.signal.addEventListener("abort", cancel, { once: true });
	const read = async () => {
		for (;;) {
			if (cancelled || performance.now() >= deadline) {
				cancel();
				throw new PrivateOwnerRequestError();
			}
			const part = await reader.read();
			if (cancelled || performance.now() >= deadline) {
				cancel();
				throw new PrivateOwnerRequestError();
			}
			if (part.done) break;
			size += part.value.byteLength;
			if (size > OWNER_BODY_LIMIT) {
				cancel();
				throw new PrivateOwnerRequestError();
			}
			let offset = 0;
			while (offset < part.value.byteLength) {
				const length = Math.min(
					chunk.length - used,
					part.value.byteLength - offset,
				);
				chunk.set(part.value.subarray(offset, offset + length), used);
				used += length;
				offset += length;
				if (used === chunk.length) {
					chunks.push(chunk);
					chunk = Buffer.alloc(64 * 1024);
					used = 0;
				}
			}
		}
		if (used > 0) chunks.push(chunk.subarray(0, used));
		return Buffer.concat(chunks, size).toString("base64");
	};
	try {
		if (request.signal.aborted) cancel();
		return await Promise.race([stopped, read()]);
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener("abort", cancel);
	}
}

export function isolatedOwnerFetch(
	env: Readonly<Record<string, string | undefined>>,
	options?: IsolatedOwnerFetchOptions,
): typeof fetch {
	return createIsolatedOwnerFetch(env, launchOwnerChild, options);
}

export function createIsolatedOwnerFetch(
	env: Readonly<Record<string, string | undefined>>,
	launchChild: PrivateOwnerChildLauncher,
	options?: IsolatedOwnerFetchOptions,
): typeof fetch {
	const egress = egressFrom(env);
	const childPath = fileURLToPath(
		new URL("../dist/isolated-owner-fetch-child.js", import.meta.url),
	);
	return async (input, init) => {
		const preparationDeadline = performance.now() + OWNER_PHASE_TIMEOUT_MS;
		let request: Request;
		let body: string | null;
		let trustedCertificates: string[];
		let maxResponseBytes: number;
		let cancellation: AbortSignal | undefined;
		try {
			request = new Request(input, init);
			cancellation = request.signal;
			assertPrivateOwnerProxy(egress.proxy);
			isolatedOwnerOrigin(
				request.url,
				options?.allowInsecureLoopback === true,
				egress.proxy !== undefined,
			);
			body = await requestBody(request, preparationDeadline);
			trustedCertificates = [...defaultCaCertificates()];
			maxResponseBytes =
				options?.maxResponseBytes ?? OWNER_DEFAULT_RESPONSE_LIMIT;
		} catch {
			if (cancellation?.aborted)
				throw new DOMException("The request was cancelled.", "AbortError");
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
			maxResponseBytes,
			allowInsecureLoopback: options?.allowInsecureLoopback === true,
			trustedCertificates,
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
		if (request.signal.aborted)
			throw new DOMException("The request was cancelled.", "AbortError");
		if (performance.now() >= preparationDeadline)
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
				reject(
					request.signal.aborted
						? new DOMException("The request was cancelled.", "AbortError")
						: new PrivateOwnerRequestError(),
				);
				return;
			}
			let settled = false;
			let spawned = false;
			let sent = false;
			const dispatchDeadline = performance.now() + OWNER_PHASE_TIMEOUT_MS;
			let size = 0;
			const chunks: Buffer[] = [];
			const finish = (
				response?: Response,
				preDispatch = false,
				aborted = false,
			) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				request.signal.removeEventListener("abort", cancel);
				if (response && performance.now() < dispatchDeadline) resolve(response);
				else
					reject(
						aborted
							? new DOMException("The request was cancelled.", "AbortError")
							: preDispatch
								? new PrivateOwnerRequestError()
								: new PrivateOwnerDispatchError(),
					);
			};
			const cancel = () => {
				if (settled) return;
				finish(undefined, !sent, !sent && request.signal.aborted);
				try {
					child.kill("SIGKILL");
				} catch {}
			};
			const timer = setTimeout(cancel, OWNER_PHASE_TIMEOUT_MS);
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
					if (bytes.byteLength > packet.data.maxResponseBytes) {
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
			if (performance.now() >= preparationDeadline) {
				cancel();
				return;
			}
			try {
				sent = true;
				child.stdin.end(encoded);
			} catch {
				cancel();
			}
		});
	};
}
