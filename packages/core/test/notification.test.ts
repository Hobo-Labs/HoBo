import { describe, expect, it } from "vitest";
import {
	NOTIFICATION_CONTRACT,
	NOTIFICATION_MAX_BODY_BYTES,
	parseNotificationRequest,
} from "../src/ports/notification.js";

const attemptId = "notification_1234";

describe("notification requests", () => {
	it("captures a bounded request without retaining caller-owned data", () => {
		const input = { attemptId, body: "repair 🔧", subject: "Alert" };
		const request = parseNotificationRequest(input);
		input.body = "changed";
		expect(request).toEqual({ attemptId, body: "repair 🔧", subject: "Alert" });
		expect(Object.getPrototypeOf(request)).toBeNull();
		expect(Object.isFrozen(request)).toBe(true);
		expect(NOTIFICATION_CONTRACT).toBe("hobo.notification/v1");
	});
	it("accepts the maximum UTF-8 body and rejects larger messages", () => {
		expect(
			parseNotificationRequest({
				attemptId,
				body: "x".repeat(NOTIFICATION_MAX_BODY_BYTES),
			}).body.length,
		).toBe(NOTIFICATION_MAX_BODY_BYTES);
		expect(() =>
			parseNotificationRequest({
				attemptId,
				body: "🔧".repeat(NOTIFICATION_MAX_BODY_BYTES / 4 + 1),
			}),
		).toThrow("notification.invalid_request");
	});
	it.each([
		{ attemptId: "short", body: "x" },
		{ attemptId: "a".repeat(65), body: "x" },
		{ attemptId, body: "" },
		{ attemptId, body: "\ud800" },
		{ attemptId, body: "\udc00" },
		{ attemptId, body: "x", subject: "" },
		{ attemptId, body: "x", subject: "a".repeat(101) },
		{ attemptId, body: "x", subject: "bad\nsubject" },
		{ attemptId, body: "x", subject: undefined },
		{ attemptId, body: "x", extra: true },
	])("rejects malformed input %#", (input) => {
		expect(() => parseNotificationRequest(input)).toThrow(
			"notification.invalid_request",
		);
	});
	it("does not invoke accessors or proxy traps", () => {
		let calls = 0;
		const input = Object.defineProperty({ attemptId }, "body", {
			enumerable: true,
			get() {
				calls++;
				return "x";
			},
		});
		expect(() => parseNotificationRequest(input)).toThrow(
			"notification.invalid_request",
		);
		const proxy = new Proxy(
			{ attemptId, body: "x" },
			{
				ownKeys() {
					calls++;
					return [];
				},
			},
		);
		expect(() => parseNotificationRequest(proxy)).toThrow(
			"notification.invalid_request",
		);
		expect(calls).toBe(0);
	});
	it("retains validation after application code replaces array methods", () => {
		const originalSome = Array.prototype.some;
		const originalIncludes = Array.prototype.includes;
		let accepted = false;
		try {
			Array.prototype.some = () => false;
			Array.prototype.includes = () => false;
			try {
				parseNotificationRequest({ attemptId, body: "x", extra: true });
				accepted = true;
			} catch {}
		} finally {
			Array.prototype.some = originalSome;
			Array.prototype.includes = originalIncludes;
		}
		expect(accepted).toBe(false);
	});
	it("does not invoke inherited descriptor accessors", () => {
		const input = { attemptId, body: "x", subject: "Alert" };
		let calls = 0;
		let result: ReturnType<typeof parseNotificationRequest> | undefined;
		try {
			Object.defineProperty(Object.prototype, "get", {
				configurable: true,
				get() {
					calls++;
					throw new Error("unexpected getter");
				},
			});
			result = parseNotificationRequest(input);
		} finally {
			Reflect.deleteProperty(Object.prototype, "get");
		}
		expect(calls).toBe(0);
		expect(result?.body).toBe("x");
	});
});
