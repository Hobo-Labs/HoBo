export enum SubscriptionStatus {
  PastDue = "past_due",
  CancelAtPeriodEnd = "cancel_at_period_end",
  Active = "active",
  Deleted = "deleted",
}

export enum PaymentPlanId {
  Hobby = "hobby",
  Pro = "pro",
  Credits10 = "credits10",
}

export interface PaymentPlan {
  id: PaymentPlanId;
  effect: PaymentPlanEffect;
}

export type PaymentPlanEffect =
  | { kind: "subscription" }
  | { kind: "credits"; amount: number };

export const paymentPlans = {
  [PaymentPlanId.Hobby]: {
    id: PaymentPlanId.Hobby,
    effect: { kind: "subscription" },
  },
  [PaymentPlanId.Pro]: {
    id: PaymentPlanId.Pro,
    effect: { kind: "subscription" },
  },
  [PaymentPlanId.Credits10]: {
    id: PaymentPlanId.Credits10,
    effect: { kind: "credits", amount: 10 },
  },
} as const satisfies Record<PaymentPlanId, PaymentPlan>;

export function prettyPaymentPlanName(planId: PaymentPlanId): string {
  const planToName = {
    [PaymentPlanId.Hobby]: "Hobby",
    [PaymentPlanId.Pro]: "Pro",
    [PaymentPlanId.Credits10]: "10 Credits",
  };
  return planToName[planId];
}

export function parsePaymentPlanId(planId: string): PaymentPlanId {
  const paymentPlanId = Object.values(PaymentPlanId).find(
    (knownPlanId) => knownPlanId === planId,
  );
  if (paymentPlanId === undefined) {
    throw new Error(`Invalid PaymentPlanId: ${planId}`);
  }
  return paymentPlanId;
}

export function parseSubscriptionStatus(status: string): SubscriptionStatus {
  const subscriptionStatus = Object.values(SubscriptionStatus).find(
    (knownStatus) => knownStatus === status,
  );
  if (subscriptionStatus === undefined) {
    throw new Error(`Invalid subscription status: ${status}`);
  }
  return subscriptionStatus;
}

export function getSubscriptionPaymentPlanIds(): PaymentPlanId[] {
  return Object.values(PaymentPlanId).filter(
    (planId) => paymentPlans[planId].effect.kind === "subscription",
  );
}
