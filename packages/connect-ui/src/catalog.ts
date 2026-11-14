import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { shadcnComponentDefinitions as ui } from "@json-render/shadcn/catalog";
import { z } from "zod";

// The connect page's component vocabulary: shadcn/ui through json-render's
// preset, and the three actions a connect step can dispatch. A spec — whether a
// model composed it or `deterministicConnectSpec` built it — may use only these,
// and the flow on the server decides what every action does.

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
	},
	actions: {
		"connect.chooseStore": {
			params: z.object({
				store: z.enum(["infisical", "1password", "bitwarden"]),
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

/** The component names a connect spec may use. */
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
] as const);
