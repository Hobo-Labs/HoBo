import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConnectFlow, FlowTransition } from "./server.js";
import type { ConfigField, ConnectProvider } from "./steps.js";
import { missingRequiredFields } from "./view.js";

// The interactive ceremony every infrastructure `up` runs when something it
// needs is not configured: instead of refusing, it asks — on the same page —
// for exactly what is missing, then continues the flow.
//
// A setting resolves from the environment first, then from what an earlier
// ceremony saved, and is asked for only when neither has it. Non-secret
// settings are saved for the next run; secrets are passed only to the active
// flow and may be used for that run or written to the owner's secret store.

/** One setting a lifecycle needs, and how a submitted value is checked. */
export interface CeremonySetting {
	readonly field: ConfigField;
	/** A message when the value is not acceptable. */
	readonly validate?: (value: string) => string | undefined;
	/** A value used when nothing else provides one; never asked for. */
	readonly fallback?: string;
}

/** Non-secret settings by name, as a ceremony saves them. */
export interface SavedSettings {
	[name: string]: string;
}

/** Where a ceremony keeps non-secret settings between runs. */
export interface SettingsStore {
	readonly read: () => Promise<Readonly<Record<string, string>>>;
	readonly write: (values: Readonly<Record<string, string>>) => Promise<void>;
}

function parseSaved(text: string | undefined): Readonly<Record<string, string>> {
	if (text === undefined || text === "") return {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed === null || Array.isArray(parsed) || !(parsed instanceof Object))
			return {};
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] =>
					Object.prototype.toString.call(entry[1]) === "[object String]",
			),
		);
	} catch {
		return {};
	}
}

/** Settings saved as JSON at `file` (created on first write). */
export function fileSettingsStore(file: string): SettingsStore {
	return {
		async read() {
			try {
				return parseSaved(await readFile(file, "utf8"));
			} catch {
				return {};
			}
		},
		async write(values) {
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, `${JSON.stringify(values, null, 2)}\n`, {
				mode: 0o600,
			});
		},
	};
}

/** One text entry somewhere durable: a secret store entry, for example. */
export interface SettingsCell {
	readonly read: () => Promise<string | undefined>;
	readonly write: (text: string) => Promise<void>;
}

/**
 * Settings kept as one JSON document in a cell, typically an entry in the
 * owner's secret store: they outlive the machine the ceremony ran on, so a
 * destroyed devbox is set up again by signing in, not by answering again.
 */
export function cellSettingsStore(cell: SettingsCell): SettingsStore {
	return {
		read: async () => parseSaved(await cell.read()),
		write: (values) => cell.write(JSON.stringify(values)),
	};
}


/** Where a run holds the secrets it was given (`TrustedVault`, `@hobo/core`). */
export interface SecretHolder {
	reveal(name: string): string | undefined;
}

export interface ResolvedSettings {
	/** Every setting that has a value. */
	readonly values: Readonly<Record<string, string>>;
	/** The settings still missing, as the fields to ask for. */
	readonly missing: readonly ConfigField[];
}

/** Resolve settings from env, then saved values, then fallbacks. */
export function resolveSettings(
	settings: readonly CeremonySetting[],
	env: Readonly<Record<string, string | undefined>>,
	saved: Readonly<Record<string, string>>,
	vault?: SecretHolder,
): ResolvedSettings {
	const values: Record<string, string> = {};
	const missing: ConfigField[] = [];
	for (const setting of settings) {
		const name = setting.field.name;
		// A secret comes from the run's trusted vault only: never from the
		// environment, never from saved settings.
		const value =
			setting.field.kind === "secret"
				? vault?.reveal(name)
				: env[name] || saved[name] || setting.fallback;
		if (value) values[name] = value;
		else if (setting.field.required) missing.push(setting.field);
	}
	return { values, missing };
}

export interface ConfigureOptions {
	readonly provider: ConnectProvider;
	readonly title: string;
	readonly reason: string;
	readonly settings: readonly CeremonySetting[];
	readonly missing: readonly ConfigField[];
	/** Persists the non-secret values the person submitted. */
	readonly store?: SettingsStore;
	readonly known: Readonly<Record<string, string>>;
	/**
	 * Continue with every value (secrets only in memory). May refuse with
	 * field errors (`errors`), e.g. a GitHub login that does not exist.
	 */
	readonly proceed: (
		values: Readonly<Record<string, string>>,
	) => Promise<
		| { readonly ok: true; readonly flow: ConnectFlow }
		| { readonly ok: false; readonly errors: Readonly<Record<string, string>> }
	>;
}

/**
 * A flow that starts by asking for what is missing (`configure`), validates
 * and saves it, then hands over to the flow `proceed` builds. With nothing
 * missing it is `proceed`'s flow from the start.
 */
export async function configureThen(
	options: ConfigureOptions,
): Promise<ConnectFlow> {
	const bySetting = new Map(options.settings.map((s) => [s.field.name, s]));
	const fields = [...options.missing];
	const includeErrorFields = (errors: Readonly<Record<string, string>>) => {
		const names = new Set(fields.map((field) => field.name));
		for (const name of Object.keys(errors)) {
			const field = bySetting.get(name)?.field;
			if (field && !names.has(name)) {
				fields.push(field);
				names.add(name);
			}
		}
	};
	const problemFor = (setting: CeremonySetting | undefined, value: string) => {
		if (!setting || !value) return undefined;
		if (
			setting.field.kind === "choice" &&
			setting.field.options &&
			!setting.field.options.some((option) => option.value === value)
		)
			return "Choose one of the listed options.";
		return setting.validate?.(value);
	};
	const invalidKnown: Record<string, string> = {};
	for (const setting of options.settings) {
		const value = options.known[setting.field.name] ?? "";
		const problem = problemFor(setting, value);
		if (problem) invalidKnown[setting.field.name] = problem;
	}
	includeErrorFields(invalidKnown);
	let initialErrors = invalidKnown;
	if (fields.length === 0) {
		const ready = await options.proceed(options.known);
		if (ready.ok) return ready.flow;
		initialErrors = { ...ready.errors };
		includeErrorFields(ready.errors);
		if (fields.length === 0) {
			const failed = {
				kind: "failed" as const,
				provider: options.provider,
				message: "Could not verify the supplied settings.",
				remediation: ["Check the configuration and try again."],
			};
			return { initial: failed, onAction: async () => ({ step: failed }) };
		}
	}
	let inner: ConnectFlow | undefined;
	return {
		initial: configureStep(options, fields, initialErrors, options.known),
		async onAction(action, params, current): Promise<FlowTransition> {
			if (inner !== undefined) return inner.onAction(action, params, current);
			if (action === "connect.cancel")
				return {
					step: {
						kind: "failed",
						provider: options.provider,
						message: "Setup was cancelled.",
						remediation: [
							"Check the provider and secret store before retrying.",
						],
					},
				};
			if (action !== "connect.submit") return { step: current };
			const submitted: Record<string, string> = {};
			for (const field of fields)
				submitted[field.name] = (params[field.name] ?? "").trim();
			const errors: Record<string, string> = {};
			for (const name of missingRequiredFields(fields, submitted))
				errors[name] = "Required.";
			for (const field of fields) {
				const value = submitted[field.name] ?? "";
				const problem = problemFor(bySetting.get(field.name), value);
				if (problem !== undefined) errors[field.name] = problem;
			}
			if (Object.keys(errors).length > 0)
				return {
					step: configureStep(options, fields, errors, submitted),
				};
			const values = { ...options.known, ...submitted };
			const ready = await options.proceed(values);
			if (!ready.ok) {
				includeErrorFields(ready.errors);
				if (!Object.keys(ready.errors).some((name) => bySetting.has(name)))
					return {
						step: {
							kind: "failed",
							provider: options.provider,
							message: "Could not verify the supplied settings.",
							remediation: ["Check the configuration and try again."],
						},
					};
				return {
					step: configureStep(options, fields, ready.errors, {
						...options.known,
						...submitted,
					}),
				};
			}
			if (options.store !== undefined) {
				const keep: SavedSettings = {
					...(await options.store.read()),
				};
				for (const field of fields)
					if (field.kind !== "secret" && submitted[field.name])
						keep[field.name] = submitted[field.name] ?? "";
				await options.store.write(keep);
			}
			inner = ready.flow;
			return { step: inner.initial };
		},
		async onCallback(query, current) {
			if (inner?.onCallback === undefined) return { step: current };
			return inner.onCallback(query, current);
		},
	};
}

function configureStep(
	options: ConfigureOptions,
	fields: readonly ConfigField[],
	errors: Readonly<Record<string, string>>,
	submitted: Readonly<Record<string, string>> = {},
) {
	return {
		kind: "configure" as const,
		provider: options.provider,
		title: options.title,
		reason: options.reason,
		fields: fields.map((field) => ({
			...field,
			// A secret is never sent back to the page, even after a refusal.
			...(field.kind === "secret"
				? { value: "" }
				: submitted[field.name]
					? { value: submitted[field.name] }
					: undefined),
			...(errors[field.name] !== undefined
				? { error: errors[field.name] }
				: undefined),
		})),
	};
}
