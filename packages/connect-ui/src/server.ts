import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Experimental_CompositionEvaluator as Evaluator } from "@json-render/core";

import { z } from "zod";

import { composeConnectSpec } from "./compose.js";
import {
	CONNECT_ACTIONS,
	type ConnectActionName,
	type ConnectStep,
	isConnectAction,
	isTerminalStep,
} from "./steps.js";
import { stepView } from "./view.js";

// domain-view: narrowed union of BrowserDirectiveRecord in data-models/connect_ui.proto.
export type BrowserDirective =
	| { readonly kind: "none" }
	| { readonly kind: "navigate"; readonly url: string }
	| {
			/** An auto-submitting form POST (GitHub's App manifest flow). */
			readonly kind: "post";
			readonly url: string;
			readonly fields: Readonly<Record<string, string>>;
	  };

export interface FlowTransition {
	readonly step: ConnectStep;
	readonly directive?: BrowserDirective;
}

export interface ConnectFlow {
	readonly initial: ConnectStep;
	/** Decide a page action. Unknown params must be refused by the flow. */
	readonly onAction: (
		action: ConnectActionName,
		params: Readonly<Record<string, string>>,
		current: ConnectStep,
	) => Promise<FlowTransition>;
	/** The provider sent the browser back with these query parameters. */
	readonly onCallback?: (
		query: URLSearchParams,
		current: ConnectStep,
	) => Promise<FlowTransition>;
}

export interface ConnectPageOptions {
	readonly flow: ConnectFlow;
	readonly evaluate?: Evaluator | undefined;
	/** Directory holding `connect.js` and `connect.css` (the built client). */
	readonly assetsDir?: string;
	readonly host?: "127.0.0.1";
	readonly port?: number;
	/**
	 * A provider that only redirects to a pre-registered URL (a Vercel
	 * Integration's Redirect URL) cannot reach the per-session path. This
	 * fixed path (`/vercel/callback`) is routed to the same callback, so the
	 * flow's own state check is what protects it; use it with a fixed `port`.
	 */
	readonly callbackPath?: string;
}

export interface ConnectPage {
	/** Open this in the browser. Unguessable; loopback only. */
	readonly url: string;
	/** The base callback URL a provider redirects back to. */
	readonly callbackUrl: string;
	/** Settles with the terminal step (connected or failed). */
	readonly done: Promise<ConnectStep>;
	/**
	 * Stop serving. With `graceMs`, first wait (at most that long) until the
	 * browser has been shown the terminal step, so a provider's redirect back
	 * lands on "connected" instead of a closed port. In-flight responses finish.
	 */
	readonly close: (options?: { readonly graceMs?: number }) => Promise<void>;
}

const DEFAULT_ASSETS = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"client",
);

const MAX_BODY_BYTES = 16 * 1024;

function send(
	res: ServerResponse,
	status: number,
	type: string,
	body: string | Buffer,
): void {
	res.writeHead(status, {
		"content-type": type,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"content-security-policy":
			"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action https://github.com; frame-ancestors 'none'",
	});
	res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		const buffer = Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new RangeError("request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** The only body `POST /action` accepts: a known action and string params. */
const ActionBodySchema = z.object({
	action: z.enum(CONNECT_ACTIONS),
	params: z.record(z.string(), z.string()).default({}),
});

type ActionBody = z.infer<typeof ActionBodySchema>;

function parseActionBody(text: string): ActionBody | undefined {
	let json: z.core.util.JSONType;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	const parsed = ActionBodySchema.safeParse(json);
	return parsed.success ? parsed.data : undefined;
}

function shell(base: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HoBo · Connect</title>
<link rel="stylesheet" href="${base}connect.css">
</head>
<body>
<main id="root" data-base="${base}"><noscript>This page needs JavaScript to show the connection step.</noscript></main>
<script type="module" src="${base}connect.js"></script>
</body>
</html>`;
}

/** Start the connect page. Close it once `done` settles. */
export async function startConnectPage(
	options: ConnectPageOptions,
): Promise<ConnectPage> {
	const token = randomBytes(24).toString("base64url");
	const base = `/s/${token}/`;
	const assetsDir = options.assetsDir ?? DEFAULT_ASSETS;
	let step: ConnectStep = options.flow.initial;
	let directive: BrowserDirective = { kind: "none" };
	let settle: (step: ConnectStep) => void = () => undefined;
	let terminalShown: () => void = () => undefined;
	const terminalViewed = new Promise<void>((resolve) => {
		terminalShown = resolve;
	});
	const done = new Promise<ConnectStep>((resolve) => {
		settle = resolve;
	});
	if (isTerminalStep(step)) settle(step);
	let pendingHandoff:
		| {
				readonly previousStep: ConnectStep;
				readonly step: ConnectStep;
				readonly directive: BrowserDirective;
		  }
		| undefined;
	let transitionQueue: Promise<void> = Promise.resolve();
	const transition = (run: () => Promise<FlowTransition>) => {
		const next = transitionQueue.then(async () => {
			if (isTerminalStep(step)) return;
			try {
				const result = await run();
				step = result.step;
				directive = result.directive ?? { kind: "none" };
			} catch {
				step = {
					kind: "failed",
					provider: step.provider,
					message: "Connection setup failed.",
					remediation: [
						"Check the provider and secret store for partially completed setup before retrying.",
					],
				};
				directive = { kind: "none" };
			}
			if (isTerminalStep(step)) settle(step);
		});
		transitionQueue = next.catch(() => undefined);
		return next;
	};

	const view = async () => {
		const composed = await composeConnectSpec(step, {
			evaluate: options.evaluate,
		});
		return JSON.stringify({
			step: step.kind,
			terminal: isTerminalStep(step),
			composedBy: composed.composedBy,
			spec: composed.spec,
			directive,
			view: stepView(step),
		});
	};

	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const fixedCallback =
				options.callbackPath !== undefined &&
				url.pathname === options.callbackPath;
			if (!fixedCallback && !url.pathname.startsWith(base))
				return send(res, 404, "text/plain", "not found");
			const route = fixedCallback
				? "callback"
				: url.pathname.slice(base.length);
			if (req.method === "GET" && route === "")
				return send(res, 200, "text/html; charset=utf-8", shell(base));
			if (
				req.method === "GET" &&
				(route === "connect.js" || route === "connect.css")
			)
				return send(
					res,
					200,
					route.endsWith(".js") ? "text/javascript" : "text/css",
					await readFile(path.join(assetsDir, route)),
				);
			if (req.method === "GET" && route === "view") {
				const body = await view();
				send(res, 200, "application/json", body);
				if (isTerminalStep(step)) terminalShown();
				return;
			}
			if (req.method === "POST" && route === "action") {
				const observedStep = step;
				const parsed = parseActionBody(await readBody(req));
				if (parsed === undefined)
					return send(
						res,
						400,
						"application/json",
						'{"error":"invalid action"}',
					);
				if (!isConnectAction(parsed.action))
					return send(
						res,
						400,
						"application/json",
						'{"error":"invalid action"}',
					);
				await transition(async () => {
					if (
						parsed.action === "connect.start" &&
						pendingHandoff?.step === step &&
						(observedStep === pendingHandoff.previousStep ||
							observedStep === step)
					)
						return { step, directive: pendingHandoff.directive };
					if (
						step !== observedStep ||
						!stepView(step).actions.some(
							(action) => action.action === parsed.action,
						)
					)
						return { step };
					const previous = step;
					const result = await options.flow.onAction(
						parsed.action,
						parsed.params,
						step,
					);
					pendingHandoff =
						parsed.action === "connect.start" &&
						result.step.kind === previous.kind &&
						result.step.provider === previous.provider &&
						result.directive !== undefined &&
						result.directive.kind !== "none"
							? {
									previousStep: previous,
									step: result.step,
									directive: result.directive,
								}
							: undefined;
					return result;
				});
				return send(res, 200, "application/json", await view());
			}
			if (req.method === "GET" && route === "callback") {
				const onCallback = options.flow.onCallback;
				if (onCallback !== undefined)
					await transition(() => {
						pendingHandoff = undefined;
						return onCallback(url.searchParams, step);
					});
				// Back to the page, which renders the step the callback produced.
				res.writeHead(303, { location: base, "cache-control": "no-store" });
				return res.end();
			}
			return send(res, 404, "text/plain", "not found");
		})().catch(() => {
			if (!res.headersSent) send(res, 500, "text/plain", "internal error");
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () =>
			resolve(),
		);
	});
	// SAFETY: listen() on a TCP host and port always reports an AddressInfo;
	// only a pipe or socket path reports a string, and none is used here.
	const { port } = server.address() as AddressInfo;
	const origin = `http://127.0.0.1:${port}`;
	return {
		url: `${origin}${base}`,
		callbackUrl:
			options.callbackPath === undefined
				? `${origin}${base}callback`
				: `${origin}${options.callbackPath}`,
		done,
		close: async (closeOptions = {}) => {
			const graceMs = closeOptions.graceMs ?? 0;
			if (graceMs > 0) {
				let timer: NodeJS.Timeout | undefined;
				await Promise.race([
					terminalViewed,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, graceMs);
					}),
				]);
				clearTimeout(timer);
			}
			await new Promise<void>((resolve) => {
				// Finish responses in flight; drop only idle keep-alive sockets.
				server.close(() => resolve());
				server.closeIdleConnections();
			});
		},
	};
}
