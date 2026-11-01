import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from './context.ts';
import { AppError } from './errors.ts';

declare module 'fastify' {
  interface FastifyRequest { ctx?: Ctx }
}

export function ctxOf(req: FastifyRequest): Ctx {
  if (!req.ctx) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
  return req.ctx;
}

export const noContent = (reply: FastifyReply) => reply.code(204).send();
