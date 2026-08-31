import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ErrorCode,
  Permission,
  createTemplateSchema,
  paginationQuerySchema,
  updateTemplateSchema,
} from '@storm/types';
import { body, params, query } from '../../lib/validation.js';
import { ok, paginated, pageArgs } from '../../lib/response.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { toTemplateDetail, toTemplateSummary } from '../../lib/transformers.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

export default async function adminTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requirePermission(Permission.TEMPLATES_MANAGE));

  app.get('/', { schema: { tags: ['Admin: Templates'] } }, async (request) => {
    const q = query(
      request,
      paginationQuerySchema.extend({ category: z.string().max(64).optional() }),
    );

    const where = {
      ...(q.category ? { category: q.category } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' as const } },
              { game: { contains: q.search, mode: 'insensitive' as const } },
              { slug: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [templates, total] = await Promise.all([
      app.prisma.gameTemplate.findMany({
        where,
        include: { _count: { select: { servers: true } } },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
        ...pageArgs(q.page, q.perPage),
      }),
      app.prisma.gameTemplate.count({ where }),
    ]);

    return paginated(templates.map(toTemplateSummary), total, q.page, q.perPage);
  });

  app.post(
    '/',
    { schema: { tags: ['Admin: Templates'], summary: 'Create a template' } },
    async (request, reply) => {
      const input = body(request, createTemplateSchema);

      const existing = await app.prisma.gameTemplate.findUnique({ where: { slug: input.slug } });
      if (existing) throw conflict('A template with that slug already exists');
      if (!Object.values(input.dockerImages).includes(input.defaultImage)) {
        throw badRequest('The default image must be one of the configured docker images');
      }

      const { variables, ...rest } = input;
      const template = await app.prisma.gameTemplate.create({
        data: {
          ...rest,
          configFiles: rest.configFiles as object,
          logConfig: rest.logConfig as object,
          variables: { create: variables },
        },
        include: {
          variables: { orderBy: { sortOrder: 'asc' } },
          _count: { select: { servers: true } },
        },
      });

      await app.audit.log(request, {
        action: 'admin.template_created',
        targetType: 'template',
        targetId: template.id,
        targetLabel: template.name,
      });

      return reply.status(201).send(ok(toTemplateDetail(template)));
    },
  );

  app.get('/:id', { schema: { tags: ['Admin: Templates'] } }, async (request) => {
    const { id } = params(request, idParam);
    const template = await app.prisma.gameTemplate.findFirst({
      where: { OR: [{ id }, { slug: id }, { uuid: id }] },
      include: {
        variables: { orderBy: { sortOrder: 'asc' } },
        _count: { select: { servers: true } },
      },
    });
    if (!template) throw notFound('Template was not found', ErrorCode.TEMPLATE_NOT_FOUND);
    return ok(toTemplateDetail(template));
  });

  app.patch('/:id', { schema: { tags: ['Admin: Templates'] } }, async (request) => {
    const { id } = params(request, idParam);
    const input = body(request, updateTemplateSchema);

    const existing = await app.prisma.gameTemplate.findUnique({ where: { id } });
    if (!existing) throw notFound('Template was not found', ErrorCode.TEMPLATE_NOT_FOUND);

    const images = input.dockerImages ?? ((existing.dockerImages ?? {}) as Record<string, string>);
    const defaultImage = input.defaultImage ?? existing.defaultImage;
    if (!Object.values(images).includes(defaultImage)) {
      throw badRequest('The default image must be one of the configured docker images');
    }

    const { variables, ...rest } = input;
    const template = await app.prisma.$transaction(async (tx) => {
      if (variables) {
        // Replacing the variable set keeps existing server values intact: the
        // link is by env variable name, and orphaned values remain read-only.
        await tx.templateVariable.deleteMany({ where: { templateId: id } });
        await tx.templateVariable.createMany({
          data: variables.map((variable) => ({ ...variable, templateId: id })),
        });
      }
      return tx.gameTemplate.update({
        where: { id },
        data: {
          ...rest,
          ...(rest.configFiles ? { configFiles: rest.configFiles as object } : {}),
          ...(rest.logConfig ? { logConfig: rest.logConfig as object } : {}),
          version: { increment: 1 },
        },
        include: {
          variables: { orderBy: { sortOrder: 'asc' } },
          _count: { select: { servers: true } },
        },
      });
    });

    await app.audit.log(request, {
      action: 'admin.template_updated',
      targetType: 'template',
      targetId: id,
      targetLabel: template.name,
      metadata: { version: template.version },
    });

    return ok(toTemplateDetail(template));
  });

  app.post(
    '/:id/clone',
    { schema: { tags: ['Admin: Templates'], summary: 'Duplicate a template' } },
    async (request, reply) => {
      const { id } = params(request, idParam);
      const input = body(
        request,
        z.object({
          name: z.string().trim().min(1).max(100),
          slug: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .regex(/^[a-z0-9-]+$/),
        }),
      );

      const source = await app.prisma.gameTemplate.findUnique({
        where: { id },
        include: { variables: true },
      });
      if (!source) throw notFound('Template was not found', ErrorCode.TEMPLATE_NOT_FOUND);

      const taken = await app.prisma.gameTemplate.findUnique({ where: { slug: input.slug } });
      if (taken) throw conflict('A template with that slug already exists');

      const clone = await app.prisma.gameTemplate.create({
        data: {
          name: input.name,
          slug: input.slug,
          game: source.game,
          category: source.category,
          description: source.description,
          author: source.author,
          dockerImages: source.dockerImages as object,
          defaultImage: source.defaultImage,
          startupCommand: source.startupCommand,
          stopCommand: source.stopCommand,
          installScript: source.installScript,
          installContainer: source.installContainer,
          installEntrypoint: source.installEntrypoint,
          startupDetection: source.startupDetection,
          crashDetection: source.crashDetection,
          configFiles: source.configFiles as object,
          logConfig: source.logConfig as object,
          defaultPorts: source.defaultPorts,
          supportedVersions: source.supportedVersions,
          parentId: source.id,
          variables: {
            create: source.variables.map((variable) => ({
              name: variable.name,
              description: variable.description,
              envVariable: variable.envVariable,
              defaultValue: variable.defaultValue,
              userViewable: variable.userViewable,
              userEditable: variable.userEditable,
              rules: variable.rules,
              sortOrder: variable.sortOrder,
            })),
          },
        },
        include: {
          variables: { orderBy: { sortOrder: 'asc' } },
          _count: { select: { servers: true } },
        },
      });

      await app.audit.log(request, {
        action: 'admin.template_cloned',
        targetType: 'template',
        targetId: clone.id,
        targetLabel: clone.name,
        metadata: { sourceId: source.id },
      });

      return reply.status(201).send(ok(toTemplateDetail(clone)));
    },
  );

  app.delete('/:id', { schema: { tags: ['Admin: Templates'] } }, async (request) => {
    const { id } = params(request, idParam);
    const template = await app.prisma.gameTemplate.findUnique({
      where: { id },
      include: { _count: { select: { servers: true } } },
    });
    if (!template) throw notFound('Template was not found', ErrorCode.TEMPLATE_NOT_FOUND);
    if (template._count.servers > 0) {
      throw conflict('Servers are still using this template. Deactivate it instead of deleting.');
    }

    await app.prisma.gameTemplate.delete({ where: { id } });
    await app.audit.log(request, {
      action: 'admin.template_deleted',
      targetType: 'template',
      targetId: id,
      targetLabel: template.name,
    });

    return ok({ deleted: true });
  });

  app.get(
    '/:id/export',
    { schema: { tags: ['Admin: Templates'], summary: 'Export as JSON' } },
    async (request) => {
      const { id } = params(request, idParam);
      const template = await app.prisma.gameTemplate.findUnique({
        where: { id },
        include: { variables: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!template) throw notFound('Template was not found', ErrorCode.TEMPLATE_NOT_FOUND);

      return ok({
        _format: 'storm-template/v1',
        name: template.name,
        slug: template.slug,
        game: template.game,
        category: template.category,
        description: template.description,
        author: template.author,
        dockerImages: template.dockerImages,
        defaultImage: template.defaultImage,
        startupCommand: template.startupCommand,
        stopCommand: template.stopCommand,
        installScript: template.installScript,
        installContainer: template.installContainer,
        installEntrypoint: template.installEntrypoint,
        startupDetection: template.startupDetection,
        crashDetection: template.crashDetection,
        configFiles: template.configFiles,
        logConfig: template.logConfig,
        defaultPorts: template.defaultPorts,
        supportedVersions: template.supportedVersions,
        variables: template.variables.map((variable) => ({
          name: variable.name,
          description: variable.description,
          envVariable: variable.envVariable,
          defaultValue: variable.defaultValue,
          userViewable: variable.userViewable,
          userEditable: variable.userEditable,
          rules: variable.rules,
          sortOrder: variable.sortOrder,
        })),
      });
    },
  );

  app.post(
    '/import',
    { schema: { tags: ['Admin: Templates'], summary: 'Import a template JSON' } },
    async (request, reply) => {
      const input = body(request, createTemplateSchema);

      const existing = await app.prisma.gameTemplate.findUnique({ where: { slug: input.slug } });
      if (existing) throw conflict('A template with that slug already exists');

      const { variables, ...rest } = input;
      const template = await app.prisma.gameTemplate.create({
        data: {
          ...rest,
          configFiles: rest.configFiles as object,
          logConfig: rest.logConfig as object,
          variables: { create: variables },
        },
        include: { variables: true, _count: { select: { servers: true } } },
      });

      await app.audit.log(request, {
        action: 'admin.template_imported',
        targetType: 'template',
        targetId: template.id,
        targetLabel: template.name,
      });

      return reply.status(201).send(ok(toTemplateDetail(template)));
    },
  );
}
