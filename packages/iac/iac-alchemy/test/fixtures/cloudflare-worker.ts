import { bindleCloudflareWorker } from "../../src/cloudflare-runtime.js";
import { application } from "./cloudflare-app.js";

export default bindleCloudflareWorker(application, "web");
