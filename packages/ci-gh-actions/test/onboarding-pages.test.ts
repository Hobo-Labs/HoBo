import { createHash } from "node:crypto";
import { createContext, Script } from "node:vm";
import { expect, it } from "vitest";
import {
	appBootstrapPage,
	appInstallationPage,
	appOwnerBootstrapPage,
} from "../src/onboarding-pages.js";

async function scriptOf(response: Response) {
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	const html = await response.text();
	expect(html).toContain('type="password"');
	expect(html).toContain('method="post"');
	expect(html).not.toMatch(/<input[^>]*name="token"/);
	const style = /<style>([\s\S]+)<\/style>/.exec(html)?.[1];
	if (!style) throw new Error("inline style missing");
	const styleDigest = createHash("sha256").update(style).digest("base64");
	expect(response.headers.get("content-security-policy")).toContain(
		`style-src 'sha256-${styleDigest}'`,
	);
	expect(style).toContain(":focus-visible");
	expect(style).toContain("@media");
	const script = /<script>([\s\S]+)<\/script>/.exec(html)?.[1];
	if (!script) throw new Error("inline script missing");
	const digest = createHash("sha256").update(script).digest("base64");
	expect(response.headers.get("content-security-policy")).toContain(
		`script-src 'sha256-${digest}'`,
	);
	expect(script).not.toMatch(/localStorage|sessionStorage/);
	return script;
}
it("submits the App manifest to GitHub without putting the operator token into the URL or browser storage", async () => {
	const script = await scriptOf(appBootstrapPage());
	const callbacks: Record<
		string,
		(event: { preventDefault(): void }) => Promise<void>
	> = {};
	const tokenField = { value: "operator-secret" };
	const form = {
		elements: {
			appName: { value: "HoBo CI" },
		},
		addEventListener: (
			name: string,
			callback: (event: { preventDefault(): void }) => Promise<void>,
		) => {
			callbacks[name] = callback;
		},
	};
	type SubmittedForm = {
		method?: string;
		action?: string;
		input?: { name: string; value: string };
		didSubmit?: boolean;
	};
	const submitted: SubmittedForm = {};
	const document = {
		getElementById: (id: string) =>
			id === "setup"
				? form
				: id === "bootstrap-token"
					? tokenField
					: { textContent: "" },
		createElement: (type: string) =>
			type === "form"
				? {
						set method(value: string) {
							submitted.method = value;
						},
						set action(value: string) {
							submitted.action = value;
						},
						append(value: { name: string; value: string }) {
							submitted.input = value;
						},
						submit() {
							submitted.didSubmit = true;
						},
					}
				: { type: "", name: "", value: "" },
		body: { append() {} },
	};
	let sent: { url: string; init: RequestInit } | undefined;
	const context = createContext({
		document,
		URL,
		JSON,
		fetch: async (url: string, init: RequestInit) => {
			sent = { url, init };
			return Response.json({
				action: "https://github.com/settings/apps/new?state=nonce",
				manifest: { name: "HoBo CI" },
			});
		},
	});
	new Script(script).runInContext(context);
	await callbacks.submit?.({ preventDefault() {} });
	expect(sent?.url).toBe("/v1/app-bootstrap/start");
	expect(new Headers(sent?.init.headers).get("authorization")).toBe(
		"Bearer operator-secret",
	);
	expect(tokenField.value).toBe("");
	expect(submitted).toMatchObject({
		method: "POST",
		action: "https://github.com/settings/apps/new?state=nonce",
		input: { name: "manifest", value: '{"name":"HoBo CI"}' },
		didSubmit: true,
	});
	expect(submitted.action).not.toContain("operator-secret");
});

it("keeps the invitation through refresh and network failure, then clears it after binding", async () => {
	const html = await appOwnerBootstrapPage().text();
	const script = /<script>([\s\S]+)<\/script>/.exec(html)?.[1];
	if (!script) throw new Error("inline script missing");
	expect(script).not.toMatch(/localStorage|sessionStorage/);
	let networkFails = true;
	let replacements = 0;
	let submit:
		| ((event: { preventDefault(): void }) => Promise<void>)
		| undefined;
	let authorization = "";
	const document = {
		getElementById: (id: string) =>
			id === "setup"
				? {
						elements: { appName: { value: "HoBo CI" } },
						addEventListener: (_name: string, callback: typeof submit) => {
							submit = callback;
						},
					}
				: { textContent: "" },
		createElement: (type: string) =>
			type === "form"
				? { append() {}, submit() {} }
				: { type: "", name: "", value: "" },
		body: { append() {} },
	};
	const makeContext = (hash: string) =>
		createContext({
			document,
			location: { hash, pathname: "/v1/app-bootstrap/setup", search: "" },
			history: {
				replaceState() {
					replacements++;
				},
			},
			URL,
			JSON,
			fetch: async (_url: string, init: RequestInit) => {
				authorization = new Headers(init.headers).get("authorization") ?? "";
				if (networkFails) throw new Error("offline");
				return Response.json({
					action: "https://github.com/settings/apps/new?state=x",
					manifest: {},
				});
			},
		});
	new Script(script).runInContext(makeContext("#invitation-value"));
	await submit?.({ preventDefault() {} });
	expect(authorization).toBe("Bearer invitation-value");
	expect(replacements).toBe(0);
	networkFails = false;
	new Script(script).runInContext(makeContext("#invitation-value"));
	expect(replacements).toBe(0);
	await submit?.({ preventDefault() {} });
	expect(replacements).toBe(1);
});
it("sends account credentials only to same-origin authorization and refuses an untrusted install URL", async () => {
	const script = await scriptOf(appInstallationPage());
	const handlers: Record<string, () => Promise<void>> = {};
	const tokenField = { value: "account-secret" };
	const connect = {
		addEventListener: (
			_name: string,
			callback: (event: { preventDefault(): void }) => Promise<void>,
		) => {
			handlers.connect = () => callback({ preventDefault() {} });
		},
	};
	const install = {
		addEventListener: (_name: string, callback: () => Promise<void>) => {
			handlers.install = callback;
		},
	};
	const status = { textContent: "" };
	const document = {
		getElementById: (id: string) =>
			id === "connect"
				? connect
				: id === "install"
					? install
					: id === "account-token"
						? tokenField
						: status,
	};
	const assigned: string[] = [];
	const location = {
		href: "https://ci.example.test/v1/app-registration/setup",
		assign: (url: string) => assigned.push(url),
	};
	const sent: { url: string; init: RequestInit }[] = [];
	const context = createContext({
		document,
		location,
		URL,
		JSON,
		fetch: async (url: string, init: RequestInit) => {
			sent.push({ url, init });
			return Response.json(
				url.endsWith("/start")
					? { authorizeUrl: "https://github.com/login/oauth/authorize?state=s" }
					: {
							installationUrl:
								"https://evil.test/apps/hobo/installations/new?state=s",
						},
			);
		},
	});
	new Script(script).runInContext(context);
	await handlers.connect?.();
	expect(sent[0]?.url).toBe("/v1/app-registration/oauth/start");
	expect(new Headers(sent[0]?.init.headers).get("authorization")).toBe(
		"Bearer account-secret",
	);
	expect(tokenField.value).toBe("");
	expect(assigned).toEqual([
		"https://github.com/login/oauth/authorize?state=s",
	]);
	await handlers.install?.();
	expect(assigned).toHaveLength(1);
	expect(status.textContent).toBe("Unexpected GitHub installation address.");
});
