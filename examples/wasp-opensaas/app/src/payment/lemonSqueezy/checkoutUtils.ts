import { createCheckout } from "@lemonsqueezy/lemonsqueezy.js";
import { CHECKOUT_SUCCESS_URL } from "../paths";

interface LemonSqueezyCheckoutSessionParams {
  storeId: string;
  variantId: string;
  userEmail: string;
  userId: string;
}

export async function createLemonSqueezyCheckoutSession({
  storeId,
  variantId,
  userEmail,
  userId,
}: LemonSqueezyCheckoutSessionParams) {
  const { data: session, error } = await createCheckout(storeId, variantId, {
    checkoutData: {
      email: userEmail,
      custom: {
        user_id: userId,
      },
    },
    productOptions: {
      redirectUrl: CHECKOUT_SUCCESS_URL,
    },
  });
  if (error) {
    throw error;
  }
  if (!session) {
    throw new Error("Checkout not found");
  }
  return {
    url: session.data.attributes.url,
    id: session.data.id,
  };
}
