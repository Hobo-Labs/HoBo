import { type SlotBinding, slotBinding } from "@hobo/core";
import { NETLIFY_STATIC_DEPLOY_PRODUCT_ID } from "./resolvers.js";
// public-contract: hosted-web capability profile advertised by Netlify's static deployment Yard binding.
export const NETLIFY_STATIC_DEPLOY_PROFILE = "web.hosted/v1";
export type NetlifyStaticDeploySlotOptions = { readonly siteId?: string };
export function staticDeployment(
	options: NetlifyStaticDeploySlotOptions = {},
): SlotBinding {
	return slotBinding({
		slot: "web",
		profile: NETLIFY_STATIC_DEPLOY_PROFILE,
		productId: NETLIFY_STATIC_DEPLOY_PRODUCT_ID,
		properties: Object.fromEntries(
			Object.entries(options).filter(([, value]) => value !== undefined),
		),
	});
}
export const NETLIFY_DEFAULT_BINDINGS = Object.freeze({
	web: Object.freeze([staticDeployment()]),
});
export const netlifySlots = Object.freeze({ staticDeployment });
