import { type App } from "@wasp.sh/spec";

export const head: App["head"] = [
  "<link rel='icon' href='/favicon.ico' />",

  "<meta name='description' content='Your apps main description and features.' />",
  "<meta name='author' content='Your (App) Name' />",
  "<meta name='keywords' content='saas, solution, product, app, service' />",

  "<meta property='og:type' content='website' />",
  "<meta property='og:title' content='Your Open SaaS App' />",
  "<meta property='og:site_name' content='Your Open SaaS App' />",
  "<meta property='og:url' content='https://your-saas-app.com' />",
  "<meta property='og:description' content='Your apps main description and features.' />",
  "<meta property='og:image' content='https://your-saas-app.com/public-banner.webp' />",
  "<meta name='twitter:image' content='https://your-saas-app.com/public-banner.webp' />",
  "<meta name='twitter:image:width' content='800' />",
  "<meta name='twitter:image:height' content='400' />",
  "<meta name='twitter:card' content='summary_large_image' />",
];
