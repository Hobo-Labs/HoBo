import type { TrustedVault } from "@hobo/core";

import { storeLabel } from "./ceremony-settings.js";
import { type OwnerChannel, ownerCaptureLine } from "./owner-channel.js";
import type { HandOffSignIn, OwnerStore } from "./owner-store.js";

/** The entry a probe reads: the lifecycle's own settings, present or not. */
function probeEntry(family: "ci" | "cd"): string {
	return `HOBO_${family.toUpperCase()}_SETTINGS`;
}

/** True when the store answers a read with the run's sign-in. */
export async function storeAnswers(
	owner: OwnerStore,
	family: "ci" | "cd",
): Promise<boolean> {
	if (owner.opened === undefined) return false;
	const read = await owner.opened.port
		.access(probeEntry(family))
		.catch(() => undefined);
	return (
		read !== undefined &&
		(read.status === "ok" || read.code === "secret-not-found")
	);
}

export type HandOffSignInOutcome =
	| Readonly<{ kind: "owner"; owner: OwnerStore }>
	| Readonly<{
			kind: "refused";
			code: string;
			message: string;
			remediation: readonly string[];
	  }>;

export interface HandOffSignInInput {
	readonly family: "ci" | "cd";
	readonly owner: OwnerStore;
	readonly open: () => Promise<OwnerStore>;
	readonly vault: TrustedVault;
	readonly channel: OwnerChannel | undefined;
}

export function handOffSignInLines(signIn: HandOffSignIn): readonly string[] {
	return [
		ownerCaptureLine(signIn.name, signIn.guide),
		`${signIn.instructions} Hand it over in the HoBo MCP App's secret form; it goes only to this run, which holds it in memory.`,
		"Then run again.",
	];
}

export async function takeHandOffSignIn(
	input: HandOffSignInInput,
): Promise<HandOffSignInOutcome> {
	const signIn = input.owner.handOffSignIn;
	if (signIn === undefined)
		return { kind: "owner", owner: { ...input.owner, opened: undefined } };
	const fam = input.family.toUpperCase();
	const store = storeLabel(input.owner.id);
	const handOver = handOffSignInLines(signIn);
	if (input.channel === undefined)
		return {
			kind: "refused",
			code: `HOBO_${fam}_STORE_NEEDS_SIGN_IN`,
			message: `A handed-off run signs in to ${store} with the ${signIn.title} you hand to it through HoBo.`,
			remediation: [
				`Run hobo ${input.family} up through the HoBo MCP server (its ci and cd tools): its secret form takes your ${signIn.title} (${signIn.guide}) straight to the run.`,
			],
		};
	await input.channel.openUrl(signIn.guide, signIn.instructions, signIn.name);
	const token = await input.channel.captureSecret({
		name: signIn.name,
		title: signIn.title,
		instructions: signIn.instructions,
	});
	if (token === undefined)
		return {
			kind: "refused",
			code: `HOBO_${fam}_STORE_NEEDS_SIGN_IN`,
			message: `${store} needs your ${signIn.title} before this run can open it.`,
			remediation: handOver,
		};
	input.vault.put(signIn.name, token);
	const owner = await input.open();
	if (await storeAnswers(owner, input.family)) return { kind: "owner", owner };
	input.vault.drop(signIn.name);
	return {
		kind: "refused",
		code: `HOBO_${fam}_STORE_SIGN_IN_REJECTED`,
		message: `${store} did not accept the ${signIn.title} you handed over.`,
		remediation: handOver,
	};
}
