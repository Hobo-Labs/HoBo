import { storeIdOf, withoutSecretEnv } from "@hobo/hobo-ci";

export function ownerStoreEnvironment(
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	const settings = withoutSecretEnv(env);
	if (env.HOBO_SECRET_STORE) {
		storeIdOf(env.HOBO_SECRET_STORE);
		settings.HOBO_SECRET_STORE = env.HOBO_SECRET_STORE;
	}
	return settings;
}
