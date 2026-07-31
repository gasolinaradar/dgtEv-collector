async function retry(fn, options = {}) {
  const { retries = 3, factor = 2, minTimeoutMs = 500, logger = console } = options;

  let delay = minTimeoutMs;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }

      const nextAttempt = attempt + 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Retry attempt ${nextAttempt} after failure: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= factor;
    }
  }
}

module.exports = {
  retry,
};
