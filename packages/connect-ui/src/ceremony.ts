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
// settings are saved for the next run; a secret is never saved anywhere but
// the owner's secret store, and the flow that receives it writes it there.

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

/** Settings saved as JSON at `file` (created on first write). */
export function fileSettingsStore(file: string): SettingsStore {
	return {
		async read() {
			try {
				const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
				if (
					parsed === null ||
					Array.isArray(parsed) ||
					!(parsed instanceof Object)
				)
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
		},
		async write(values) {
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, `${JSON.stringify(values, null, 2)}\n`, {
				mode: 0o600,
			});
		},
	};
}

/** The settings store `hobo <family> up` uses under HOBO_HOME. */
export function familySettingsStore(
	family: string,
	env: Readonly<Record<string, string | undefined>>,
): SettingsStore {
	const home = env.HOBO_HOME || path.join(env.HOME || ".", ".hobo");
	return fileSettingsStore(path.join(home, "ceremonies", `${family}.json`));
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
): ResolvedSettings {
	const values: Record<string, string> = {};
	const missing: ConfigField[] = [];
	for (const setting of settings) {
		const name = setting.field.name;
		const value =
			env[name] ||
			(setting.field.kind === "secret" ? undefined : saved[name]) ||
			setting.fallback;
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
	if (options.missing.length === 0) {
		const ready = await options.proceed(options.known);
		if (ready.ok) return ready.flow;
		return {
			initial: configureStep(options, options.missing, ready.errors),
			onAction: async (_action, _params, current) => ({ step: current }),
		};
	}
	let inner: ConnectFlow | undefined;
	const bySetting = new Map(options.settings.map((s) => [s.field.name, s]));
	return {
		initial: configureStep(options, options.missing, {}),
		async onAction(action, params, current): Promise<FlowTransition> {
			if (inner !== undefined) return inner.onAction(action, params, current);
			if (action === "connect.cancel")
				return {
					step: {
						kind: "failed",
						provider: options.provider,
						message: "Cancelled. Nothing was configured or created.",
						remediation: ["Run the command again when you are ready."],
					},
				};
			if (action !== "connect.submit") return { step: current };
			const submitted: Record<string, string> = {};
			for (const field of options.missing)
				submitted[field.name] = (params[field.name] ?? "").trim();
			const errors: Record<string, string> = {};
			for (const name of missingRequiredFields(options.missing, submitted))
				errors[name] = "Required.";
			for (const field of options.missing) {
				const value = submitted[field.name] ?? "";
				const problem = value
					? bySetting.get(field.name)?.validate?.(value)
					: undefined;
				if (problem !== undefined) errors[field.name] = problem;
			}
			if (Object.keys(errors).length > 0)
				return {
					step: configureStep(options, options.missing, errors, submitted),
				};
			const values = { ...options.known, ...submitted };
			const ready = await options.proceed(values);
			if (!ready.ok)
				return {
					step: configureStep(
						options,
						options.missing,
						ready.errors,
						submitted,
					),
				};
			if (options.store !== undefined) {
				const keep: SavedSettings = {
					...(await options.store.read()),
				};
				for (const field of options.missing)
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
			...(field.kind !== "secret" && submitted[field.name]
				? { value: submitted[field.name] }
				: undefined),
			...(errors[field.name] !== undefined
				? { error: errors[field.name] }
				: undefined),
		})),
	};
}
