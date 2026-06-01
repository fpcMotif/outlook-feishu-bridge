// Shared AAD / Graph error-envelope parsing for the Self-Forward chain.
//
// Both the client_credentials token exchange and the Graph `message: forward`
// call return errors in one of two shapes — the AAD `{ error, error_description }`
// form or the Graph `{ error: { code, message } }` form. `readError` normalizes
// either into a flat `{ code, message }` for the result envelope and logging.

export interface AadErrorEnvelope {
  error?: string | { code?: string; message?: string };
  error_description?: string;
  error_codes?: number[];
}

export async function readError(
  res: Response,
): Promise<{ code: string; message: string }> {
  let body: AadErrorEnvelope | string = "";
  try {
    body = (await res.json()) as AadErrorEnvelope;
  } catch {
    try {
      body = await res.text();
    } catch {
      body = "";
    }
  }
  if (typeof body === "string") {
    return { code: `HTTP_${res.status}`, message: body || res.statusText };
  }
  if (typeof body.error === "string") {
    return {
      code: body.error,
      message: body.error_description ?? res.statusText,
    };
  }
  const err = body.error ?? {};
  return {
    code: err.code ?? `HTTP_${res.status}`,
    message: err.message ?? res.statusText,
  };
}
