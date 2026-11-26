import { runSleep } from "./step.js";

export function sleep(duration: string | number): Promise<void> {
  return runSleep(duration);
}

export function cron(expr: string) {
  return { expr };
}
