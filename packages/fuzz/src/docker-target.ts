import { connect, createServer } from "node:net";
import { createControlFuzzServer } from "./control-http.js";

const target = await createControlFuzzServer();
const port = Number(new URL(target.url).port);
const relay = createServer((client) => {
	const upstream = connect(port, "127.0.0.1");
	client.pipe(upstream).pipe(client);
	client.on("error", () => upstream.destroy());
	upstream.on("error", () => client.destroy());
});
await new Promise<void>((resolve) => relay.listen(8080, "0.0.0.0", resolve));
process.stdout.write("target ready\n");
