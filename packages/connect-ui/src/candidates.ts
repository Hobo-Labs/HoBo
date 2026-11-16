import type { Experimental_CompositionCandidate as Candidate } from "@json-render/core";

import { type ConnectStep, providerLabel } from "./steps.js";

// The configured component instances one step offers (json-render
// "candidates"). A model may choose and arrange them; it cannot invent props
// or actions. Every candidate is complete on its own, and its description says
// what it is for without naming the owner, the repository or any value: the
// descriptions are what a composer sends to its evaluator.

/** Candidates whose id ends in this are left out of the deterministic spec. */
// public-contract: the marker compose.ts reads to tell required candidates from optional ones.
export const OPTIONAL_SUFFIX = "-optional";

function heading(text: string): Candidate {
	return {
		id: "title",
		description: "The step's title",
		element: { type: "Heading", props: { text, level: "h2" } },
	};
}

function text(id: string, value: string, description: string): Candidate {
	return {
		id,
		description,
		element: { type: "Text", props: { text: value, variant: "body" } },
	};
}

function root(title: string, description: string): Candidate {
	return {
		id: "root",
		description: "The card that holds the whole step",
		root: true,
		element: {
			type: "Card",
			props: {
				title,
				description,
				maxWidth: "md",
				centered: true,
				className: null,
			},
		},
	};
}

function cancel(): Candidate {
	return {
		id: `cancel${OPTIONAL_SUFFIX}`,
		description: "Lets the person stop before anything is created",
		element: {
			type: "Button",
			props: { label: "Cancel", variant: "secondary", disabled: null },
			on: { press: { action: "connect.cancel", params: {} } },
		},
	};
}

/** The candidates for one step, in the order a person reads them. */
export function connectCandidates(step: ConnectStep): readonly Candidate[] {
	const provider = providerLabel(step.provider);
	switch (step.kind) {
		case "choose-secret-store": {
			const recommended = step.stores.find((store) => store.recommended);
			return [
				root(
					`Connect ${provider}`,
					"Where should HoBo keep the credentials it receives?",
				),
				heading("Choose a secret store"),
				text(
					"why",
					`${provider} hands its credentials over once. HoBo writes them straight into the store you choose and keeps only the store's references; workloads read them back with their own identity, so no secret lives in a repository, a CI variable or this page.`,
					"Explains why a secret store is needed and that no secret is shown",
				),
				...step.stores.map(
					(store): Candidate => ({
						id: `store-${store.id}`,
						description: `Chooses ${store.label} as the secret store`,
						resource: "store-choice",
						maxUses: 1,
						element: {
							type: "Button",
							props: {
								label: store.recommended
									? `${store.label} (recommended)`
									: store.label,
								variant: store.recommended ? "primary" : "secondary",
								disabled: null,
							},
							on: {
								press: {
									action: "connect.chooseStore",
									params: { store: store.id },
								},
							},
						},
					}),
				),
				...(recommended === undefined
					? []
					: [
							{
								id: `oidc-note${OPTIONAL_SUFFIX}`,
								description:
									"Notes that the recommended store needs no stored secret",
								element: {
									type: "Badge",
									props: {
										text: `${recommended.label}: OIDC sign-in, no secret to keep`,
										variant: "outline",
									},
								},
							} satisfies Candidate,
						]),
				cancel(),
			];
		}
		case "create-github-app":
			return [
				root(
					"Create the GitHub App",
					"GitHub registers the App from a manifest HoBo reviewed",
				),
				heading(`Create ${step.appName}`),
				text(
					"what",
					`GitHub will ask you to confirm an App owned by ${step.owner} with the permissions and events HoBo CI needs. When you confirm, GitHub returns its credentials once and HoBo stores them in ${step.store} before this page says anything else.`,
					"Explains what confirming on GitHub creates and where its credentials go",
				),
				{
					id: "start",
					description: "Opens GitHub's App confirmation screen",
					element: {
						type: "Button",
						props: {
							label: "Continue on GitHub",
							variant: "primary",
							disabled: null,
						},
						on: { press: { action: "connect.start", params: {} } },
					},
				},
				cancel(),
			];
		case "authorize-vercel":
			return [
				root("Connect Vercel", "Vercel asks you to authorize HoBo CD"),
				heading("Authorize HoBo on Vercel"),
				text(
					"what",
					`Vercel will ask you to allow HoBo CD to manage projects${step.team === undefined ? "" : ` in the team ${step.team}`}. The access it grants goes straight to ${step.store}; deployments then sign in to Vercel with OIDC, never with a stored token.`,
					"Explains what authorizing on Vercel grants and where the access goes",
				),
				{
					id: "start",
					description: "Opens Vercel's authorization screen",
					element: {
						type: "Button",
						props: {
							label: "Continue on Vercel",
							variant: "primary",
							disabled: null,
						},
						on: { press: { action: "connect.start", params: {} } },
					},
				},
				cancel(),
			];
		case "depositing":
			return [
				root(`Connecting ${provider}`, "Storing what the provider returned"),
				{
					id: "progress",
					description: "Shows how many credentials are stored so far",
					element: {
						type: "Progress",
						props: {
							value: step.done,
							max: step.total,
							label: `Stored ${step.done} of ${step.total} in ${step.store}`,
						},
					},
				},
			];
		case "connected":
			return [
				root(`${provider} connected`, "You can close this page"),
				{
					id: "done",
					description: "Confirms the connection succeeded",
					element: {
						type: "Alert",
						props: {
							title: `${provider} is connected`,
							message: `Credentials are in ${step.store}. ${step.nextHint}`,
							type: "success",
						},
					},
				},
				...step.references.map(
					(reference, index): Candidate => ({
						id: `ref-${index}`,
						description: "One stored credential's reference (never its value)",
						element: {
							type: "Text",
							props: { text: reference, variant: "code" },
						},
					}),
				),
				...(step.link === undefined
					? []
					: [
							{
								id: "link",
								description: "The next thing the person may want to open",
								element: {
									type: "Link",
									props: { label: step.link.label, href: step.link.href },
								},
							} satisfies Candidate,
						]),
			];
		case "failed":
			return [
				root(`${provider} was not connected`, "Nothing was left half-created"),
				{
					id: "error",
					description: "Says what went wrong",
					element: {
						type: "Alert",
						props: {
							title: "Connection failed",
							message: step.message,
							type: "error",
						},
					},
				},
				...step.remediation.map((line, index) =>
					text(`fix-${index}`, line, "One thing the person can do to fix it"),
				),
			];
	}
}
