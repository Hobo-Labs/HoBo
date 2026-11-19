import { bench, describe } from "vitest";

describe("__SLUG__ hot path", () => {
  bench("replace with the real operation", () => {
    JSON.parse(JSON.stringify({ replace: "me" }));
  });
});
