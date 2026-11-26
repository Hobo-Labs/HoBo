import {
	type ConfigField,
	type ConnectActionName,
	type ConnectStep,
	providerLabel,
} from "./steps.js";

// The exact component a step needs, generated from the step itself.
//
// A step is data the flow owns; its view is derived from it: only the fields
// that step is missing, the one choice it asks for, and the actions that move
// it. The browser renders a view with vercel-labs/ui (UI SDK) parts — Field,
// Input, PasswordInput, RadioGroup, Button, Progress — so every control is
// named and an agent can operate the same page through `createAgent` and
// WebMCP. Nothing in a view is a secret value: a secret field arrives empty and
// leaves through `connect.submit` straight to the flow, which writes it to the
// owner's secret store.

export interface ViewAction {
	readonly action: ConnectActionName;
	readonly label: string;
	readonly variant: "primary" | "secondary";
	readonly submits: boolean;
	/**
	 * The sentence an agent must have a person confirm before pressing it
	 * (`data-agent-confirm`): handing off to a provider, giving a secret.
	 */
	readonly confirm?: string;
}

export interface StepView {
	readonly step: ConnectStep["kind"];
	readonly provider: string;
	readonly title: string;
	readonly description: string;
	readonly tone: "neutral" | "success" | "error";
	readonly explanation: readonly string[];
	readonly fields: readonly ConfigField[];
	readonly progress?: {
		readonly value: number;
		readonly max: number;
		readonly label: string;
	};
	readonly references: readonly string[];
	readonly link?: { readonly label: string; readonly href: string };
	readonly actions: readonly ViewAction[];
}

const cancel: ViewAction = {
	action: "connect.cancel",
	label: "Cancel",
	variant: "secondary",
	submits: false,
};

export function stepView(step: ConnectStep): StepView {
	const provider = providerLabel(step.provider);
	const base = {
		step: step.kind,
		provider: step.provider,
		fields: [],
		references: [],
		tone: "neutral",
	} as const;
	switch (step.kind) {
		case "configure": {
			const hasSecret = step.fields.some((field) => field.kind === "secret");
			const confirmation = [
				step.submitConfirm,
				hasSecret
					? `Submits the ${provider} settings, including the secret you entered, to continue setup.`
					: undefined,
			]
				.filter((message) => message !== undefined)
				.join(" ");
			return {
				...base,
				title: step.title,
				description: `Finish setting up ${provider}`,
				explanation: [step.reason],
				fields: step.fields.map((field) =>
					field.kind === "secret" ? { ...field, value: "" } : field,
				),
				actions: [
					{
						action: "connect.submit",
						label: "Save and continue",
						variant: "primary",
						submits: true,
						...(confirmation ? { confirm: confirmation } : undefined),
					},
					cancel,
				],
			};
		}
		case "choose-secret-store": {
			const recommended = step.stores.find((store) => store.recommended);
			return {
				...base,
				title: `Connect ${provider}`,
				description: "Choose where HoBo keeps the credentials it receives",
				explanation: [
					`${provider} hands its credentials over once. HoBo writes them straight into the store you choose and keeps only the store's references; workloads read them back with their own identity, so no secret lives in a repository, a CI variable or this page.`,
				],
				fields: [
					{
						name: "store",
						label: "Secret store",
						kind: "choice",
						required: true,
						...(recommended !== undefined
							? { value: recommended.id }
							: undefined),
						options: step.stores.map((store) => ({
							value: store.id,
							label: store.recommended
								? `${store.label} (recommended)`
								: store.label,
							description:
								store.signIn === "oidc"
									? "Workloads sign in with OIDC: no secret to keep."
									: "Workloads sign in with a service account.",
						})),
					},
				],
				actions: [
					{
						action: "connect.chooseStore",
						label: "Use this store",
						variant: "primary",
						submits: true,
					},
					cancel,
				],
			};
		}
		case "create-github-app":
			return {
				...base,
				title: `Create ${step.appName}`,
				description: "GitHub registers the App from a manifest HoBo reviewed",
				explanation: [
					`GitHub will ask you to confirm an App owned by ${step.owner} with the permissions and events HoBo CI needs.`,
					`When you confirm, GitHub returns its credentials once, and HoBo stores them in ${step.store} before this page says anything else.`,
				],
				actions: [
					{
						action: "connect.start",
						label: "Continue on GitHub",
						variant: "primary",
						submits: false,
						confirm: `Opens GitHub to create the ${step.appName} App owned by ${step.owner}.`,
					},
					cancel,
				],
			};
		case "authorize-vercel":
			return {
				...base,
				title: "Authorize HoBo on Vercel",
				description: "Vercel asks you to install HoBo CD",
				explanation: [
					`Vercel will ask you to allow HoBo CD to manage projects${step.team === undefined ? "" : ` in the team ${step.team}`}.`,
					`The access it grants is stored in ${step.store}; the Vercel junction reads the token for each convergence.`,
				],
				actions: [
					{
						action: "connect.start",
						label: "Continue on Vercel",
						variant: "primary",
						submits: false,
						confirm: "Opens Vercel to install HoBo CD on your account or team.",
					},
					cancel,
				],
			};
		case "depositing":
			return {
				...base,
				title: `Connecting ${provider}`,
				description: "Storing what the provider returned",
				explanation: [],
				progress: {
					value: step.done,
					max: step.total,
					label: `Stored ${step.done} of ${step.total} in ${step.store}`,
				},
				actions: [],
			};
		case "connected":
			return {
				...base,
				tone: "success",
				title: `${provider} is connected`,
				description: "You can close this page",
				explanation: [`Credentials are in ${step.store}. ${step.nextHint}`],
				references: step.references,
				...(step.link !== undefined ? { link: step.link } : undefined),
				actions: [],
			};
		case "failed":
			return {
				...base,
				tone: "error",
				title: `${provider} was not connected`,
				description: "Setup did not complete; check the details below.",
				explanation: [step.message, ...step.remediation],
				actions: [],
			};
	}
}

export function missingRequiredFields(
	fields: readonly ConfigField[],
	values: Readonly<Record<string, string>>,
): string[] {
	return fields
		.filter((field) => field.required && !(values[field.name] ?? "").trim())
		.map((field) => field.name);
}
