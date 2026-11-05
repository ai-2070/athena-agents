// Refusing a request from a route: the message, and the HTTP status it is answered with (server/rpc.ts).
export const refuse = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};

const hasStatus = (e: unknown): boolean => !!e && typeof e === 'object' && 'status' in e;

/** Runs fn (or awaits it); an error it throws without a status was meant for you, so it is refused (400, or the
 *  status given) in its own words instead of answered as a 500. For functions whose plain errors say what to change,
 *  or that a thing isn't there (404). */
export function refusing<T>(fn: () => T, status = 400): T {
  const refused = (e: unknown): never => {
    if (hasStatus(e)) throw e;
    return refuse(e instanceof Error ? e.message : String(e), status);
  };
  try {
    const r = fn();
    return (r instanceof Promise ? r.catch(refused) : r) as T;
  } catch (e) {
    return refused(e);
  }
}
