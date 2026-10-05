import type { FastifyRequest, FastifyReply } from "fastify";

/** Cancel provider reads on an aborted request or an unfinished response disconnect. */
export function requestCancellationSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  const aborted = () => controller.abort();
  const closed = () => {
    if (!reply.raw.writableEnded) controller.abort();
    request.raw.removeListener("aborted", aborted);
    reply.raw.removeListener("close", closed);
  };
  request.raw.once("aborted", aborted);
  reply.raw.once("close", closed);
  if (request.raw.aborted) controller.abort();
  return controller.signal;
}
