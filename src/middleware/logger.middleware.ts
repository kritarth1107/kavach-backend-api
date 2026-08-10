import { FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import logger from '../utils/logger.util';

/**
 * Fastify lifecycle hooks to track fatal errors securely.
 */
export const loggerHook = {
    onError: async (request: FastifyRequest, reply: FastifyReply, error: FastifyError) => {
         logger.error(`[AUDIT] FATAL ERROR CATCH`, { error: error.message, stack: error.stack, url: request.url });
    }
};

export default loggerHook;
