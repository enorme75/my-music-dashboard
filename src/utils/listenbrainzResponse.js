// ListenBrainz returns HTTP error codes with a JSON body shaped as
// { "code": <http code>, "error": "<message>" }. 204 means "no data" for the
// stats endpoints and carries no body.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function assertListenBrainzResponse(status, data) {
  if (status === 204) return null;
  if (status >= 200 && status < 300) return data;

  const error = new Error(`[ListenBrainz] ${data?.error || `Request failed (HTTP ${status})`}`);
  error.name = "ListenBrainzApiError";
  error.listenBrainzCode = Number(data?.code ?? status);
  error.statusCode = 502;

  if (RETRYABLE_STATUSES.has(status)) {
    error.response = { status, headers: {} };
  }

  throw error;
}

module.exports = { assertListenBrainzResponse, RETRYABLE_STATUSES };
