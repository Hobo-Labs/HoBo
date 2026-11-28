import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { relaySetupForm } from "@hobo/ci-gh-actions";
import { RELAY_SETUP_ENTRIES } from "@hobo/ci-vercel";
import type { OwnerSettingsStore } from "@hobo/hobo-ci";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { JsonObject, JsonValue } from "../src/json.js";
import {
	createMcpOwnerChannel,
	createOwnerCaptureApp,
	INFISICAL_CLI_SESSION,
	OWNER_HANDOFF_SPECS,
} from "../src/mcp-owner-channel.js";
import {
	createInfisicalCaptureConnector,
	RELAY_SECRET_CAPTURE_SPECS,
} from "../src/mcp-secret-capture.js";
import {
	CHOOSE_SECRET_STORE_TOOL,
	createStoreChoiceApp,
	STORE_OPTIONS,
} from "../src/mcp-store-choice.js";

const described = {
	title: z.string().optional(),
	description: z.string().optional(),
};

const stringSchema = z.strictObject({
	type: z.literal("string"),
	...described,
	minLength: z.number().int().nonnegative().optional(),
	maxLength: z.number().int().nonnegative().optional(),
	format: z.enum(["email", "uri", "date", "date-time"]).optional(),
	default: z.string().optional(),
});

const numberSchema = z.strictObject({
	type: z.enum(["number", "integer"]),
	...described,
	minimum: z.number().optional(),
	maximum: z.number().optional(),
	default: z.number().optional(),
});

const booleanSchema = z.strictObject({
	type: z.literal("boolean"),
	...described,
	default: z.boolean().optional(),
});

const titledOption = z.strictObject({ const: z.string(), title: z.string() });

const untitledSingleSelect = z
	.strictObject({
		type: z.literal("string"),
		...described,
		enum: z.array(z.string()).min(1),
		default: z.string().optional(),
	})
	.refine(
		(field) =>
			field.default === undefined || field.enum.includes(field.default),
	);

const titledSingleSelect = z
	.strictObject({
		type: z.literal("string"),
		...described,
		oneOf: z.array(titledOption).min(1),
		default: z.string().optional(),
	})
	.refine(
		(field) =>
			field.default === undefined ||
			field.oneOf.some((option) => option.const === field.default),
	);

const multiSelect = z.strictObject({
	type: z.literal("array"),
	...described,
	minItems: z.number().int().nonnegative().optional(),
	maxItems: z.number().int().nonnegative().optional(),
	items: z.union([
		z.strictObject({
			type: z.literal("string"),
			enum: z.array(z.string()).min(1),
		}),
		z.strictObject({ anyOf: z.array(titledOption).min(1) }),
	]),
	default: z.array(z.string()).optional(),
});

const primitiveSchema = z.union([
	stringSchema,
	numberSchema,
	booleanSchema,
	untitledSingleSelect,
	titledSingleSelect,
	multiSelect,
]);

const formRequest = z.strictObject({
	mode: z.literal("form"),
	message: z.string().min(1),
	requestedSchema: z
		.strictObject({
			$schema: z.string().optional(),
			type: z.literal("object"),
			properties: z.record(z.string(), primitiveSchema),
			required: z.array(z.string()).optional(),
		})
		.refine((schema) =>
			(schema.required ?? []).every((name) =>
				Object.hasOwn(schema.properties, name),
			),
		),
});

function expectConformant(sent: readonly JsonObject[]) {
	expect(sent.length).toBeGreaterThan(0);
	for (const params of sent) {
		const parsed = formRequest.safeParse(params);
		expect(parsed.error?.issues, JSON.stringify(params)).toBeUndefined();
	}
}

function emptyLocator(): OwnerSettingsStore {
	const saved: Record<string, string> = {};
	return {
		assertCurrent: () => {},
		onOwnerChoice: () => {},
		selectionRevision: () => 0,
		read: async () => ({ ...saved }),
		write: async (entries: Readonly<Record<string, string>>) => {
			Object.assign(saved, entries);
		},
	};
}

describe("every elicitation/create form HoBo sends conforms to MCP 2025-11-25", () => {
	it("refuses the shapes the restricted schema leaves out", () => {
		const base = { mode: "form", message: "m" };
		const refused: JsonObject[] = [
			{
				...base,
				requestedSchema: {
					type: "object",
					properties: {
						store: { type: "string", enum: ["a"], enumNames: ["A"] },
					},
				},
			},
			{
				...base,
				requestedSchema: { type: "object", properties: { a: null } },
			},
			{
				...base,
				requestedSchema: {
					type: "object",
					properties: { a: { type: "string" } },
					required: ["b"],
				},
			},
			{
				...base,
				requestedSchema: {
					type: "object",
					properties: { a: { type: "string", format: "hostname" } },
				},
			},
			{
				...base,
				requestedSchema: {
					type: "object",
					properties: { a: { type: "object", properties: {} } },
				},
			},
			{
				message: "m",
				requestedSchema: { type: "object", properties: {} },
			},
		];
		for (const params of refused)
			expect(
				formRequest.safeParse(params).success,
				JSON.stringify(params),
			).toBe(false);
	});

	it("asks for the store and then each store's own fields in conformant forms", async () => {
		const support = { formElicitation: true, apps: false };
		for (const option of STORE_OPTIONS) {
			const sent: JsonObject[] = [];
			const app = createStoreChoiceApp({ locatorFor: emptyLocator });
			await app.callTool(
				CHOOSE_SECRET_STORE_TOOL,
				{ cwd: "/synthetic/project" },
				support,
				async (_method, params): Promise<JsonValue> => {
					sent.push(params);
					return sent.length === 1
						? { action: "accept", content: { store: option.id } }
						: { action: "decline" };
				},
			);
			expect(sent).toHaveLength(2);
			expectConformant(sent);
		}
	});

	it("asks for the hosted relay's missing configuration in a conformant form", () => {
		const form = z
			.record(z.string(), z.json())
			.parse(relaySetupForm(RELAY_SETUP_ENTRIES));
		expectConformant([form]);
		expect(
			Object.keys(
				z
					.object({
						requestedSchema: z.object({
							properties: z.record(z.string(), z.json()),
						}),
					})
					.parse(form).requestedSchema.properties,
			),
		).toHaveLength(RELAY_SETUP_ENTRIES.length + 2);
	});

	it("asks the owner to confirm a link in a conformant form", async () => {
		const sent: JsonObject[] = [];
		await createMcpOwnerChannel({
			form: async (params) => {
				sent.push(params);
				return { action: "decline" };
			},
		}).confirm({
			url: "https://example.com/approve",
			message: "Approve it, then submit.",
		});
		expectConformant(sent);
	});

	it("captures each owner value in a conformant form, with and without its link", async () => {
		const sent: JsonObject[] = [];
		const owner = createMcpOwnerChannel();
		const capture = createOwnerCaptureApp({
			owner,
			connector: createInfisicalCaptureConnector({
				projectDir: mkdtempSync(path.join(tmpdir(), "hobo-elicitation-")),
			}),
			remote: true,
			elicit: async (params) => {
				sent.push(params);
				return { action: "decline" };
			},
		});
		const support = {
			apps: false,
			formElicitation: true,
			urlElicitation: false,
		};
		try {
			await owner.openUrl(
				"https://example.com/sign-in",
				"Sign in first",
				INFISICAL_CLI_SESSION,
			);
			await owner.captureSecret({
				name: INFISICAL_CLI_SESSION,
				title: INFISICAL_CLI_SESSION,
				instructions: "",
			});
			await capture.callTool(
				"capture_secret",
				{ name: INFISICAL_CLI_SESSION },
				support,
			);
			for (const spec of [
				...RELAY_SECRET_CAPTURE_SPECS,
				...OWNER_HANDOFF_SPECS,
			])
				await capture.callTool("capture_secret", { name: spec.name }, support);
			expect(
				sent.some((params) => JSON.stringify(params).includes('"link"')),
			).toBe(true);
			expectConformant(sent);
		} finally {
			await capture.close();
		}
	});
});
