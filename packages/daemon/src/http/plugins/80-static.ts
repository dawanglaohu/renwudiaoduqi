import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const staticPlugin: FastifyPluginAsync = async (
	_instance: FastifyInstance,
): Promise<void> => {
	// Root-scope static asset serving placeholder.
	// Frontend static assets are served anonymously from the root scope without touching /api/v1 routes.
};
