import { bindle } from "../../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../../bindles/src/session-replay.js";
import type { BindleRuntimeContext } from "../../../../bindles/src/types.js";
import {
	bindleCloudflareWorker,
	cloudflareBindings,
	withCloudflareR2,
} from "../../src/cloudflare-runtime.js";

export const grant = {
	grantEpoch: `sha256:${"1".repeat(64)}`,
	bucketEpoch: `sha256:${"2".repeat(64)}`,
};
export const entrypoint = (context?: BindleRuntimeContext) => async () => {
	const value = await cloudflareBindings(context)
		.bucket("assets")
		.read("hello");
	return new Response(
		value === undefined ? "missing" : new TextDecoder().decode(value.body),
	);
};
export const neutralApplication = bindle(
	"r2-app",
	{ require: ["http", "blob-bounded-objects"], runtimes: ["javascript"] },
	(b) => {
		const assets = b.bucket().allow("read");
		const web = b
			.web(entrypoint)
			.with(sessionReplay({ enabled: false }))
			.dependsOn(assets);
		return { assets, web };
	},
);
export const application = withCloudflareR2(neutralApplication, {
	assets: grant,
});
export default bindleCloudflareWorker(application, "web");
