import type { CommandModule, CommandRunInput } from "@hobo/cli";
import {
	type CeremonySetting,
	type ConnectPage,
	type ConnectStep,
	configureThen,
	startConnectPage,
} from "@hobo/connect-ui";
import { openInBrowser } from "@hobo/hobo-ci";

import { isJsonArray, isJsonObject, isJsonString } from "./json.js";

// `hobo up`'s ceremony for providers: when planning finds a resource that no
// registered (and approved) provider can serve, `up` does not just refuse. It
// opens the setup page, offers the installable providers that advertise the
// resource's port, connects the chosen ones (the `hobo add` path: register,
// then approve), and runs `up` again. A rejected plan has no side effects, so
// running `up` first and holding the ceremony only on that rejection changes
// nothing for a plan that already resolves.
//
// Without a person at a browser — or for `--what-if` — the rejection stands,
// and says which `hobo add` would satisfy each resource.

const PROVIDER_GAPS: ReadonlySet<string> = new Set([
	"capability.port-unavailable",
	"capability.provider-not-approved",
	"placement.providers-unavailable",
]);

interface Gap {
	readonly resource: string;
	readonly port: string;
	readonly candidates: readonly string[];
}

export interface ProviderCeremonyDeps {
	/** `hobo add`: registers a provider (and approves it on a second run if held). */
	readonly add: CommandModule;
	/** Installable providers that advertise a port. */
	readonly candidates: (port: string) => readonly string[];
	readonly interactive?: boolean;
	readonly openBrowser?: (url: string) => void;
	readonly startPage?: typeof startConnectPage;
	readonly timeoutMs?: number;
}

function gapsOf(
	result: Awaited<ReturnType<CommandModule["run"]>>,
	candidates: ProviderCeremonyDeps["candidates"],
): Gap[] {
	const data = result.data;
	if (!isJsonObject(data) || !isJsonArray(data.remediations)) return [];
	return data.remediations.flatMap((entry) => {
		if (
			!isJsonObject(entry) ||
			!isJsonString(entry.code) ||
			!PROVIDER_GAPS.has(entry.code) ||
			!isJsonString(entry.resource) ||
			!isJsonString(entry.requiredPort)
		)
			return [];
		return [
			{
				resource: entry.resource,
				port: entry.requiredPort,
				candidates: candidates(entry.requiredPort),
			},
		];
	});
}

function fieldName(resource: string): string {
	return `provider:${resource}`;
}

/** Wrap `up` with the provider ceremony. */
export function createProviderCeremonyUp(
	up: CommandModule,
	deps: ProviderCeremonyDeps,
): CommandModule {
	return {
		implemented: up.implemented ?? true,
		run: async (input) => {
			const first = await up.run(input);
			if (first.code !== "HOBO_PLAN_REJECTED") return first;
			const gaps = gapsOf(first, deps.candidates);
			if (gaps.length === 0) return first;
			const suggestions = gaps.map((gap) =>
				gap.candidates.length > 0
					? `${gap.resource} (port ${gap.port}): hobo add ${gap.candidates.join(" | ")}`
					: `${gap.resource} (port ${gap.port}): no installable provider offers it; register one with hobo registry add <manifest>`,
			);
			const unanswerable = gaps.some((gap) => gap.candidates.length === 0);
			if (
				input.flags.whatIf === true ||
				unanswerable ||
				!(deps.interactive ?? Boolean(process.stdout.isTTY))
			)
				return {
					...first,
					remediation: [...(first.remediation ?? []), ...suggestions],
				};

			const settings: CeremonySetting[] = gaps.map((gap) => ({
				field: {
					name: fieldName(gap.resource),
					label: `Provider for ${gap.resource}`,
					description: `No connected provider serves port ${gap.port}; choose one to connect.`,
					kind: "choice",
					required: true,
					...(gap.candidates[0] !== undefined
						? { value: gap.candidates[0] }
						: undefined),
					options: gap.candidates.map((id) => ({ value: id, label: id })),
				},
			}));
			const added: string[] = [];
			const flow = await configureThen({
				provider: "hobo",
				title: "Connect the providers this deployment needs",
				reason: `hobo up found ${gaps.length === 1 ? "a resource" : `${gaps.length} resources`} no connected provider can serve. Choose a provider for each; HoBo approves the selected providers, including any on hold, and runs up again.`,
				submitConfirm:
					"Approve the selected providers, including any on hold, and run hobo up again?",
				settings,
				missing: settings.map((setting) => setting.field),
				known: {},
				async proceed(values) {
					const chosen = [
						...new Set(
							gaps.map((gap) => values[fieldName(gap.resource)] ?? ""),
						),
					].filter(Boolean);
					const errors: Record<string, string> = {};
					for (const id of chosen) {
						const addInput: CommandRunInput = {
							...input,
							verb: "add",
							args: [id],
						};
						let result = await deps.add.run(addInput);
						// A provider that registers held (data.approved false) is approved
						// by a second add: choosing it here is the operator's decision.
						if (
							result.ok === true &&
							isJsonObject(result.data) &&
							result.data.approved === false
						)
							result = await deps.add.run(addInput);
						if (result.ok !== true) {
							const gap = gaps.find(
								(g) => values[fieldName(g.resource)] === id,
							);
							if (gap !== undefined)
								errors[fieldName(gap.resource)] =
									result.message ?? `Could not connect ${id}.`;
						} else added.push(id);
					}
					if (Object.keys(errors).length > 0) return { ok: false, errors };
					const done: ConnectStep = {
						kind: "connected",
						provider: "hobo",
						store: "the Yard registry",
						references: added.map((id) => `provider:${id}`),
						nextHint: "hobo up continues in your terminal.",
						link: undefined,
					};
					return {
						ok: true,
						flow: {
							initial: done,
							onAction: async (_action, _params, current) => ({
								step: current,
							}),
						},
					};
				},
			});
			const page: ConnectPage = await (deps.startPage ?? startConnectPage)({
				flow,
			});
			let timer: NodeJS.Timeout | undefined;
			let browserLaunched = false;
			let step: ConnectStep;
			try {
				input.emitProgress(
					`Choose providers for this deployment in your browser: ${page.url}`,
				);
				(deps.openBrowser ?? openInBrowser)(page.url);
				browserLaunched = true;
				const timedOut = new Promise<ConnectStep>((resolve) => {
					timer = setTimeout(
						() =>
							resolve({
								kind: "failed",
								provider: "hobo",
								message: "The setup page was not finished in time.",
								remediation: suggestions,
							}),
						deps.timeoutMs ?? 15 * 60_000,
					);
				});
				step = await Promise.race([page.done, timedOut]);
			} finally {
				clearTimeout(timer);
				await page.close({ graceMs: browserLaunched ? 10_000 : 0 });
			}
			if (step.kind !== "connected")
				return {
					...first,
					remediation: [...(first.remediation ?? []), ...suggestions],
				};
			for (const id of added) input.emitProgress(`connected provider ${id}`);
			const again = await up.run(input);
			return {
				...again,
				data: { ...again.data, connectedProviders: added },
			};
		},
	};
}
