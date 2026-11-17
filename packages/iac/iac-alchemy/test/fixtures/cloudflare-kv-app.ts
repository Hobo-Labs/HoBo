import { bindle } from "../../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../../bindles/src/session-replay.js";
import type { BindleRuntimeContext } from "../../../../bindles/src/types.js";
import {
	bindleCloudflareWorker,
	cloudflareBindings,
	withCloudflareEventualKv,
} from "../../src/cloudflare-runtime.js";

export const entrypoint = (context?: BindleRuntimeContext) => async () => {
	const value = await cloudflareBindings(context).kv("cache").get("greeting");
	return new Response(
		value === undefined ? "missing" : new TextDecoder().decode(value),
	);
};

export const neutralApplication = bindle(
	"kv-app",
	{
		require: ["http", "kv-eventual-read"],
		runtimes: ["javascript"],
	},
	(builder) => {
		const cache = builder.kv().allow("get");
		const web = builder
			.web(entrypoint)
			.with(sessionReplay({ enabled: false }))
			.dependsOn(cache);
		return { cache, web };
	},
);

export const application = withCloudflareEventualKv(neutralApplication, {
	cache: "read-only",
});

export default bindleCloudflareWorker(application, "web");
