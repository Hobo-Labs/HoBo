import { PassThrough } from "node:stream";
import { createHoboMcpServer, createSecretCaptureApp } from "@hobo/mcp";
import {
	Client,
	type JSONRPCMessage,
	parseJSONRPCMessage,
	type Transport,
} from "@modelcontextprotocol/client";
import {
	AppBridge,
	getToolUiResourceUri,
	isToolVisibilityAppOnly,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { createComposedHoboCli } from "../../src/cli.js";
import {
	createInfisicalCaptureConnector,
	RELAY_SECRET_CAPTURE_SPECS,
} from "../../src/mcp-secret-capture.js";
import {
	createMcpStdioSession,
	localOperatorAuth,
	serveMcpStdio,
} from "../../src/mcp-stdio.js";
import { createStoreChoiceApp } from "../../src/mcp-store-choice.js";

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing test fixture");
	return value;
}

describe("EVAL: MCP Apps SDK owner store picker", () => {
	it("routes the rendered picker through the SDK bridge and privately calls HoBo", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const saved: Record<string, string> = {};
		const project = "/synthetic/project";
		const privateValue = "synthetic-private-owner-coordinate";
		let established = false;
		const sessions = {
			establish: async () => {
				established = true;
				return { status: "established" as const, store: "Infisical" as const };
			},
			status: () =>
				established
					? { established: true, store: "Infisical" as const }
					: { established: false },
			credentials: () => ({
				resolve: async () => {
					throw new Error("not used");
				},
			}),
			entries: () => {
				throw new Error("not used");
			},
			agentVault: () => undefined,
			close: async () => {},
		};
		const session = createMcpStdioSession(
			createSecretCaptureApp({
				specs: RELAY_SECRET_CAPTURE_SPECS,
				connector: createInfisicalCaptureConnector({ bindingStore: undefined }),
			}),
			createStoreChoiceApp({
				cwd: project,
				locatorFor: () => ({
					read: async () => ({ ...saved }),
					write: async (values: Record<string, string>) => {
						Object.assign(saved, values);
					},
				}),
				sessions,
			}),
		);
		const serving = serveMcpStdio({
			server: createHoboMcpServer({ cli: createComposedHoboCli() }),
			auth: localOperatorAuth({}),
			input,
			output,
			session,
		});
		let buffer = "";
		const serverTransport: Transport = {
			async start() {
				output.on("data", (chunk: Buffer) => {
					buffer += chunk.toString();
					for (;;) {
						const end = buffer.indexOf("\n");
						if (end < 0) break;
						const line = buffer.slice(0, end);
						buffer = buffer.slice(end + 1);
						this.onmessage?.(JSON.parse(line));
					}
				});
			},
			async send(message: JSONRPCMessage) {
				input.write(`${JSON.stringify(message)}\n`);
			},
			async close() {
				input.end();
				await serving;
				this.onclose?.();
			},
		};
		const client = new Client(
			{ name: "sdk-eval", version: "1.0.0" },
			{
				capabilities: {
					extensions: {
						"io.modelcontextprotocol/ui": {
							mimeTypes: ["text/html;profile=mcp-app"],
						},
					},
				},
			},
		);
		await client.connect(serverTransport);
		const calls: unknown[] = [];
		const messages: unknown[] = [];
		try {
			const tools = (await client.listTools()).tools;
			const picker = tools.find((tool) => tool.name === "choose_secret_store");
			const submit = tools.find((tool) => tool.name === "submit_store_choice");
			expect(picker).toBeDefined();
			expect(submit).toBeDefined();
			const uri = getToolUiResourceUri(required(picker));
			expect(uri).toBe("ui://hobo/store-choice");
			expect(isToolVisibilityAppOnly(required(submit))).toBe(true);
			const shown = await client.callTool({
				name: "choose_secret_store",
				arguments: { cwd: project },
			});
			expect(shown.structuredContent).toEqual({ status: "shown" });
			const contents = (await client.readResource({ uri: required(uri) }))
				.contents;
			const resource = required(contents[0]);
			if (!("text" in resource))
				throw new Error("Expected a text app resource");
			const dom = new JSDOM(resource.text, {
				runScripts: "outside-only",
				url: "https://example.invalid",
			});
			const bridge = new AppBridge(
				null,
				{ name: "sdk-eval-host", version: "1.0.0" },
				{ serverTools: {} },
			);
			let resolveInitialized!: () => void;
			const initialized = new Promise<void>((resolve) => {
				resolveInitialized = resolve;
			});
			bridge.oninitialized = resolveInitialized;
			bridge.oncalltool = async (params) => {
				calls.push(params.name);
				return await client.callTool(params);
			};
			bridge.onmessage = async (params) => {
				messages.push(params);
				return {};
			};
			const view = dom.window;
			const transport: Transport = {
				async start() {},
				async send(message: JSONRPCMessage) {
					const event = new view.MessageEvent("message", { data: message });
					Object.defineProperty(event, "source", { value: view });
					view.dispatchEvent(event);
				},
				async close() {
					this.onclose?.();
				},
			};
			view.postMessage = (message: JSONRPCMessage) => {
				queueMicrotask(() =>
					transport.onmessage?.(parseJSONRPCMessage(message)),
				);
			};
			await bridge.connect(transport);
			const script = view.document.querySelector("script");
			expect(script?.textContent).toBeTruthy();
			view.eval(required(script?.textContent));
			await initialized;
			await bridge.sendToolInput({ arguments: { cwd: project } });
			const radio = required(
				view.document.querySelector<HTMLInputElement>(
					'input[value="infisical"]',
				),
			);
			radio.checked = true;
			radio.dispatchEvent(new view.Event("change", { bubbles: true }));
			required(view.document.querySelector<HTMLInputElement>("#p")).value =
				privateValue;
			const completed = new Promise<void>((resolve) => {
				const observer = new view.MutationObserver(() => {
					if (view.document.querySelector("#say")?.textContent) {
						observer.disconnect();
						resolve();
					}
				});
				observer.observe(required(view.document.querySelector("#say")), {
					childList: true,
					characterData: true,
					subtree: true,
				});
			});
			required(view.document.querySelector("form")).dispatchEvent(
				new view.Event("submit", { bubbles: true, cancelable: true }),
			);
			await completed;
			expect(calls).toEqual(["submit_store_choice"]);
			expect(saved.INFISICAL_PROJECT_ID).toBe(privateValue);
			expect(established).toBe(true);
			await vi.waitFor(() => expect(messages).toHaveLength(1), {
				timeout: 1000,
			});
			expect(JSON.stringify({ shown, messages })).not.toContain(privateValue);
			await bridge.close();
			dom.window.close();
		} finally {
			await client.close();
		}
	}, 30_000);
});
