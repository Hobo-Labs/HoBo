import { createAgent37FakeServer } from "./server.mts";

const port = Number(process.env.AGENT37_FAKE_PORT ?? "4180");
const apiKey = process.env.AGENT37_FAKE_API_KEY ?? "";
if (apiKey === "") {
	console.error("container-entry: AGENT37_FAKE_API_KEY is required");
	process.exit(1);
}

const fake = await createAgent37FakeServer({
	apiKey,
	host: "0.0.0.0",
	port,
});
console.log(`agent37 fake listening ${fake.baseUrl}`);
