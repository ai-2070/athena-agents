// Refusing a request from a route: the message, and the HTTP status it is answered with (server/rpc.ts).
export const refuse = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};
