import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions as ui } from "@json-render/shadcn/catalog";
import { z } from "zod";

export const connectCatalog = defineCatalog(schema, {
	components: {
		Card: ui.Card,
		Stack: ui.Stack,
		Heading: ui.Heading,
		Text: ui.Text,
		Button: ui.Button,
		Alert: ui.Alert,
		Badge: ui.Badge,
		Link: ui.Link,
		Progress: ui.Progress,
		Separator: ui.Separator,
		Radio: ui.Radio,
		Input: ui.Input,
	},
	actions: {
		"connect.submit": {
			params: z.record(z.string(), z.string()),
			description: "Submit configured settings and continue the flow",
		},
		"connect.chooseStore": {
			params: z.object({
				store: z.enum(["infisical", "1password", "bitwarden", "yard"]),
			}),
			description:
				"Choose the third-party secret store the provider's credentials go to",
		},
		"connect.start": {
			params: z.object({}),
			description:
				"Start the provider's consent screen (GitHub App manifest, Vercel authorization)",
		},
		"connect.cancel": {
			params: z.object({}),
			description: "Stop the connection; nothing is created",
		},
	},
});

export type ConnectCatalog = typeof connectCatalog;

export const CONNECT_COMPONENTS = Object.freeze([
	"Card",
	"Stack",
	"Heading",
	"Text",
	"Button",
	"Alert",
	"Badge",
	"Link",
	"Progress",
	"Separator",
	"Radio",
	"Input",
] as const);
