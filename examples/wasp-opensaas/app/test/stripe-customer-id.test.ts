import { describe, expect, it } from "vitest";
import { getCustomerId } from "../src/payment/stripe/customerId";

describe("Stripe customer ID", () => {
  it("accepts both a string ID and an expanded customer", () => {
    expect(getCustomerId("cus_123")).toBe("cus_123");
    expect(getCustomerId({ id: "cus_456" })).toBe("cus_456");
  });

  it("rejects missing or empty customer IDs", () => {
    expect(() => getCustomerId(null)).toThrow("Customer is missing");
    expect(() => getCustomerId("")).toThrow("Customer is missing");
    expect(() => getCustomerId({ id: "" })).toThrow("Customer is missing");
  });
});
