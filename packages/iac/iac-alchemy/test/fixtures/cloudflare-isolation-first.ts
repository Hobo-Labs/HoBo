import { bindleCloudflareWorker } from "../../src/cloudflare-runtime.js";
import { firstApplication } from "./cloudflare-isolation-app.js";

export default bindleCloudflareWorker(firstApplication, "web");
