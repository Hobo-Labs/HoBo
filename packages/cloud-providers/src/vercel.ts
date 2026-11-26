import {
	type VercelYardSpecOptions,
	vercelYardSpec,
} from "@hobo/provider-vercel";
import type { Yard as ParsedYard } from "@hobo/yards";

import { type ComposedYardOptions, composeYard } from "./compose.js";

export {
	blob,
	cron,
	delayedQueue,
	edgeConfig,
	edgeFunction,
	gitFunction,
	project,
	queue,
	sandboxHost,
	schedule,
	staticDeployment,
	type VercelBlobSlotOptions,
	type VercelCronSlotOptions,
	type VercelEdgeConfigSlotOptions,
	type VercelEdgeFunctionSlotOptions,
	type VercelGitFunctionSlotOptions,
	type VercelProjectSlotOptions,
	type VercelQueueSlotOptions,
	type VercelSandboxHostSlotOptions,
	type VercelScheduleSlotOptions,
	type VercelStaticDeploySlotOptions,
} from "@hobo/provider-vercel";

// public-contract: the provider id the authoring surface reads off this namespace; changing it repoints every Yard opened with yard(vercel, …).
export const PROVIDER_ID = "vercel";

export const DEFAULT_VERCEL_YARD_NAME = "vercel";

export interface VercelYardOptions
	extends ComposedYardOptions,
		VercelYardSpecOptions {}

export function Yard(options: VercelYardOptions = {}): ParsedYard {
	return composeYard(
		DEFAULT_VERCEL_YARD_NAME,
		vercelYardSpec(options),
		options,
	);
}
