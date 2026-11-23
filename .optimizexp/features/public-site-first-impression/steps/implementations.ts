import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export type PublicSiteVisit = {
  title: string;
  heading: string;
  description: string;
  nextAction: string;
  guidePath: string;
  guideHeading: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const siteRoot = path.join(repoRoot, "site");
const astro = path.join(siteRoot, "node_modules/astro/astro.js");

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a local port");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function visitPublicSite(): Promise<PublicSiteVisit> {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [astro, "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: siteRoot,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let startupError: Error | undefined;
  server.on("error", (error) => { startupError = error; });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-8_192); });
  }
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
  try {
    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`site server stopped: ${output}`);
      try {
        const response = await fetch(`${origin}/HoBo/`, { signal: AbortSignal.timeout(2_000) });
        await response.text();
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`site server did not become ready: ${output}`);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin === origin) await route.continue();
        else await route.abort();
      });
      await page.goto(`${origin}/HoBo/`, { waitUntil: "domcontentloaded" });
      const title = await page.title();
      const heading = await page.locator("#trailhead-title").innerText();
      const description = await page.locator("#trailhead .hero-sub").first().innerText();
      const link = page.locator("#trailhead .hero-ctas a").first();
      const nextAction = await link.innerText();
      await Promise.all([page.waitForURL("**/guide/getting-started/**"), link.click()]);
      return {
        title,
        heading,
        description,
        nextAction,
        guidePath: new URL(page.url()).pathname,
        guideHeading: await page.locator("h1").first().innerText(),
      };
    } finally {
      await browser.close();
    }
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    await closed;
  }
}
