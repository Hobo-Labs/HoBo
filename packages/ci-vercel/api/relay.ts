export { http as default } from "../src/entry.js";

// Preserve the bytes signed by GitHub; JSON reserialization changes the HMAC.
export const config = { api: { bodyParser: false } };
