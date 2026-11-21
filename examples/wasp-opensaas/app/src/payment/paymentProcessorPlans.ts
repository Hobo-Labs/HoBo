import { env } from "wasp/server";
import { type PaymentPlan, PaymentPlanId } from "./plans";

export const paymentProcessorPlanIds = {
  [PaymentPlanId.Hobby]: env.PAYMENTS_HOBBY_SUBSCRIPTION_PLAN_ID,
  [PaymentPlanId.Pro]: env.PAYMENTS_PRO_SUBSCRIPTION_PLAN_ID,
  [PaymentPlanId.Credits10]: env.PAYMENTS_CREDITS_10_PLAN_ID,
} as const satisfies Record<PaymentPlanId, string>;

export function getPaymentProcessorPlanId(paymentPlan: PaymentPlan): string {
  return paymentProcessorPlanIds[paymentPlan.id];
}

export function getPaymentPlanIdByPaymentProcessorPlanId(
  paymentProcessorPlanId: string,
): PaymentPlanId {
  for (const [planId, processorPlanId] of Object.entries(
    paymentProcessorPlanIds,
  )) {
    if (processorPlanId === paymentProcessorPlanId) {
      return planId as PaymentPlanId;
    }
  }

  throw new Error(
    `Unknown payment processor plan ID: ${paymentProcessorPlanId}`,
  );
}
