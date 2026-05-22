// Every response wrapped in {contract, ok, data|error}. See CONTRACT.md §Versioning.

export const CONTRACT_VERSION = '0.1';

export function ok(data) {
  return { contract: CONTRACT_VERSION, ok: true, data };
}

export function err(code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return { contract: CONTRACT_VERSION, ok: false, error };
}

// Express helper: wraps an async route handler so thrown errors become
// `internal` envelopes rather than 500-text-html.
export function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`[${req.method} ${req.path}]`, e);
      res.status(500).json(err('internal', e.message ?? String(e)));
    }
  };
}
