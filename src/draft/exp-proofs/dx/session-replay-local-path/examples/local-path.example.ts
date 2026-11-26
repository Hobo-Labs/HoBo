import { proveLocalReplayPath } from "../src/session-replay-local-path.js";

const proof = await proveLocalReplayPath();
if (!proof.ok) {
	console.error(proof);
	process.exit(1);
}
console.log(JSON.stringify(proof, null, 2));
