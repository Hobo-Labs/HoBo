import { env } from "@hobo/bindles";

export const campEnv = env({
	GREETING_PREFIX: "{{greetingPrefix}}",
	APP_TITLE: "{{appTitle}}",
});
