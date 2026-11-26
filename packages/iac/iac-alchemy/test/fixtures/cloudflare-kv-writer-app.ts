import { bindle } from "../../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../../bindles/src/session-replay.js";
import type { BindleRuntimeContext } from "../../../../bindles/src/types.js";
import {
	bindleCloudflareWorker,
	cloudflareBindings,
	withCloudflareEventualKv,
} from "../../src/cloudflare-runtime.js";

export const entrypoint = (context?: BindleRuntimeContext) => async () => {
	await cloudflareBindings(context)
		.kv("cache")
		.set({ key: "greeting", value: new TextEncoder().encode("written") });
	return new Response("ok");
};

const neutral = bindle(
	"kv-app",
	{ require: ["http", "kv-eventual-write"], runtimes: ["javascript"] },
	(builder) => {
		const cache = builder.kv().allow("set");
		const web = builder
			.web(entrypoint)
			.with(sessionReplay({ enabled: false }))
			.dependsOn(cache);
		return { cache, web };
	},
);

export const application = withCloudflareEventualKv(neutral, {
	cache: {
		mode: "write-only",
		grantEpoch: `sha256:${"2".repeat(64)}`,
		namespaceEpoch: `sha256:${"4".repeat(64)}`,
	},
});

export default bindleCloudflareWorker(application, "web");
