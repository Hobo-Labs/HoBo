import { bindleCloudflareWorker } from "../../src/cloudflare-runtime.js";

const entrypoint = () => () => new Response("ui works");

export const uiApplication = {
	name: "shop",
	resources: {
		panel: {
			kind: "ui",
			name: "panel",
			stableId: "ui:panel",
			declaredAllow: [],
			dependsOn: [],
			annotations: [],
		},
	},
	edges: [],
	requirements: {},
	entrypoint: () => entrypoint,
};

export default bindleCloudflareWorker(uiApplication, "panel");
