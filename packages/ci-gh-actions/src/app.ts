import { bindle } from "@hobo/bindles";

export const ciGithubAppBindle = bindle("hobo-ci-github-app", (b) => ({
	app: b.api(),
}));
