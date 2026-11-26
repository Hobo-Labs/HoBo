# Reducing browser-test flakes

Reproduce the failure with the same browser, viewport, and concurrency used by the failing run. Inspect the trace, console errors, failed requests, and the visible state before changing the test.

Wait for observable readiness instead of sleeping for an arbitrary duration:

```javascript
await page.goto('/dashboard');
await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
await page.getByRole('button', { name: 'Continue' }).click();
```

Give each test isolated data and clean up the resources it creates. Use deterministic network responses when the external service is outside the behavior under test:

```javascript
await page.route('**/api/profile', async (route) => {
  await route.fulfill({ json: { name: 'Ada' } });
});
```

Set the viewport, locale, and timezone explicitly when they affect the result. Wait for fonts or animations when they affect an assertion. Prefer accessible roles and visible text over DOM structure. Fix the cause of a flake before adding retries or changing timeouts.
