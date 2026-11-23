import { env } from "wasp/server";
import * as z from "zod";

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${env.PLAUSIBLE_API_KEY}`,
};

const pageViewsResultSchema = z.object({
  results: z.object({
    pageviews: z.object({
      value: z.number(),
    }),
  }),
});

const pageViewSourcesResultSchema = z.object({
  results: z.array(
    z.object({
      source: z.string(),
      visitors: z.number(),
    }),
  ),
});

export async function getDailyPageViews() {
  const totalViews = await getTotalPageViews();
  const prevDayViewsChangePercent = await getPrevDayViewsChangePercent();

  return {
    totalViews,
    prevDayViewsChangePercent,
  };
}

async function getTotalPageViews() {
  const response = await fetch(
    `${env.PLAUSIBLE_BASE_URL}/v1/stats/aggregate?site_id=${env.PLAUSIBLE_SITE_ID}&metrics=pageviews`,
    {
      method: "GET",
      headers,
    },
  );
  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }
  const json = pageViewsResultSchema.parse(await response.json());

  return json.results.pageviews.value;
}

async function getPrevDayViewsChangePercent() {
  const today = new Date();
  const yesterday = new Date(today.setDate(today.getDate() - 1))
    .toISOString()
    .split("T")[0];
  const dayBeforeYesterday = new Date(
    new Date().setDate(new Date().getDate() - 2),
  )
    .toISOString()
    .split("T")[0];

  const pageViewsYesterday = await getPageviewsForDate(yesterday);
  const pageViewsDayBeforeYesterday =
    await getPageviewsForDate(dayBeforeYesterday);

  console.table({
    pageViewsYesterday,
    pageViewsDayBeforeYesterday,
  });

  if (pageViewsYesterday === 0 || pageViewsDayBeforeYesterday === 0) {
    return "0";
  }
  const change =
    ((pageViewsYesterday - pageViewsDayBeforeYesterday) /
      pageViewsDayBeforeYesterday) *
    100;
  return change.toFixed(0);
}

async function getPageviewsForDate(date: string) {
  const url = `${env.PLAUSIBLE_BASE_URL}/v1/stats/aggregate?site_id=${env.PLAUSIBLE_SITE_ID}&period=day&date=${date}&metrics=pageviews`;
  const response = await fetch(url, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }
  const data = pageViewsResultSchema.parse(await response.json());
  return data.results.pageviews.value;
}

export async function getSources() {
  const url = `${env.PLAUSIBLE_BASE_URL}/v1/stats/breakdown?site_id=${env.PLAUSIBLE_SITE_ID}&property=visit:source&metrics=visitors`;
  const response = await fetch(url, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }
  const data = pageViewSourcesResultSchema.parse(await response.json());
  return data.results;
}
