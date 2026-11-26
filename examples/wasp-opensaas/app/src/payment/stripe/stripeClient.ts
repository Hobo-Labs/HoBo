import Stripe from "stripe";
import { env } from "wasp/server";

const STRIPE_API_VERSION = "2025-04-30.basil";

export const stripeClient = new Stripe(env.STRIPE_API_KEY, {
  apiVersion: STRIPE_API_VERSION,
});
