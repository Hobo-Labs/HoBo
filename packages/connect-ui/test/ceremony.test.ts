import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	type CeremonySetting,
	cellSettingsStore,
	configureThen,
	fileSettingsStore,
} from "../src/ceremony.js";
import type { ConnectFlow } from "../src/server.js";
import { stepView } from "../src/view.js";

const login: CeremonySetting = {
	field: { name: "login", label: "Owner", kind: "text", required: true },
	validate: (value) => (/^[a-z]+$/u.test(value) ? undefined : "Invalid owner."),
};
const store: CeremonySetting = {
	field: { name: "store", label: "Store", kind: "text", required: true },
};
const onward: ConnectFlow = {
	initial: {
		kind: "connected",
		provider: "github",
		store: "infisical",
		references: [],
		nextHint: "done",
		link: undefined,
	},
	onAction: async (_action, _params, current) => ({ step: current }),
};

describe("saved settings", () => {
	it("treats a missing file as new, but preserves and refuses a damaged locator", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hobo-settings-"));
		const file = join(dir, "locator.json");
		try {
			const settings = fileSettingsStore(file);
			expect(await settings.read()).toEqual({});
			await writeFile(file, '{"HOBO_SECRET_STORE":');
			await expect(settings.read()).rejects.toThrow();
			expect(await readFile(file, "utf8")).toBe('{"HOBO_SECRET_STORE":');
			await writeFile(file, JSON.stringify({ HOBO_SECRET_STORE: "bitwarden" }));
			expect(await settings.read()).toEqual({ HOBO_SECRET_STORE: "bitwarden" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not confuse an unreadable path with missing settings", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hobo-settings-"));
		try {
			await expect(fileSettingsStore(dir).read()).rejects.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.each([
		"",
		"null",
		"[]",
		'{"HOBO_SECRET_STORE":1}',
	])("refuses malformed settings content %j instead of dropping fields", async (content) => {
		const settings = cellSettingsStore({
			read: async () => content,
			write: async () => {},
		});
		await expect(settings.read()).rejects.toThrow();
	});
});

describe("configureThen", () => {
	it("retains the approval prompt after a refused submission", async () => {
		const flow = await configureThen({
			provider: "hobo",
			title: "Choose a provider",
			reason: "A provider is needed.",
			submitConfirm: "Approve the selected provider?",
			settings: [login],
			missing: [login.field],
			known: {},
			proceed: async () => ({ ok: true, flow: onward }),
		});
		const prompt = (step: typeof flow.initial) =>
			stepView(step).actions.find(
				(action) => action.action === "connect.submit",
			)?.confirm;
		expect(prompt(flow.initial)).toBe("Approve the selected provider?");
		const refused = await flow.onAction("connect.submit", {}, flow.initial);
		expect(prompt(refused.step)).toBe("Approve the selected provider?");
	});

	it("lets the user correct a failed lookup when all settings were supplied", async () => {
		const flow = await configureThen({
			provider: "github",
			title: "Setup",
			reason: "Configure owner.",
			settings: [login],
			missing: [],
			known: { login: "unknown" },
			proceed: async (values) =>
				values.login === "valid"
					? { ok: true, flow: onward }
					: { ok: false, errors: { login: "Owner was not found." } },
		});
		expect(flow.initial).toMatchObject({
			kind: "configure",
			fields: [{ name: "login", error: "Owner was not found." }],
		});
		const fixed = await flow.onAction(
			"connect.submit",
			{ login: "valid" },
			flow.initial,
		);
		expect(fixed.step.kind).toBe("connected");
	});

	it("lets the user correct an invalid preconfigured value before continuing", async () => {
		const calls: string[] = [];
		const flow = await configureThen({
			provider: "github",
			title: "Setup",
			reason: "Configure owner.",
			settings: [login],
			missing: [],
			known: { login: "bad value" },
			proceed: async (values) => {
				calls.push(values.login ?? "");
				return { ok: true, flow: onward };
			},
		});
		expect(flow.initial).toMatchObject({
			kind: "configure",
			fields: [{ name: "login", error: "Invalid owner." }],
		});
		expect(calls).toEqual([]);
		const fixed = await flow.onAction(
			"connect.submit",
			{ login: "valid" },
			flow.initial,
		);
		expect(fixed.step.kind).toBe("connected");
		expect(calls).toEqual(["valid"]);
	});

	it("shows a failed lookup for a known field and accepts a correction", async () => {
		const flow = await configureThen({
			provider: "github",
			title: "Setup",
			reason: "Configure owner.",
			settings: [login, store],
			missing: [store.field],
			known: { login: "unknown" },
			proceed: async (values) =>
				values.login === "valid"
					? { ok: true, flow: onward }
					: { ok: false, errors: { login: "Owner was not found." } },
		});
		const failed = await flow.onAction(
			"connect.submit",
			{ store: "infisical" },
			flow.initial,
		);
		expect(failed.step).toMatchObject({
			kind: "configure",
			fields: expect.arrayContaining([
				expect.objectContaining({
					name: "login",
					error: "Owner was not found.",
				}),
			]),
		});
		const fixed = await flow.onAction(
			"connect.submit",
			{ store: "infisical", login: "valid" },
			failed.step,
		);
		expect(fixed.step.kind).toBe("connected");
	});
});
