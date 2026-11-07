// Local integration tests must not fetch machine-specific Request.cf metadata.
process.env.NODE_ENV = "test";
process.env.WRANGLER_SEND_METRICS = "false";
