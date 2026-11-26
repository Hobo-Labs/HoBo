import { bindleCloudflareWorker } from "../../src/cloudflare-runtime.js";
import { secondApplication } from "./cloudflare-isolation-app.js";

export default bindleCloudflareWorker(secondApplication, "web");
