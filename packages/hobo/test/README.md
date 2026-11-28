# HoBo test fixtures

Tests that load `examples/hello-bindle` require the Hono adapter's built output.
The `@hobo/hobo#build` Turbo task builds `@hobo/adapter-hono` before HoBo so
the fixture can load it after a HoBo build.
