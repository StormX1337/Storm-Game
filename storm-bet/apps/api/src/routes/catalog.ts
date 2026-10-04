import {
  eventListQuery,
  idParam,
  sharedSelectionsQuery,
  sportKeyParam,
} from '@storm-bet/validation';
import type { FastifyInstance } from 'fastify';
import { parse } from '../lib/validate';
import type { CatalogService } from '../services/catalog';
import type { InsightsService } from '../services/insights';

export function catalogRoutes(catalog: CatalogService, insights: InsightsService) {
  return async (app: FastifyInstance) => {
    app.get('/sports', async () => catalog.listSports());

    app.get('/sports/:sport', async (request) => {
      const { sport } = parse(sportKeyParam, request.params);
      return catalog.getSport(sport);
    });

    app.get('/events', async (request) => catalog.listEvents(parse(eventListQuery, request.query)));

    app.get('/leagues/top', async () => catalog.topLeagues(12));

    app.get('/live', async (request) => {
      const query = parse(eventListQuery, {
        ...(request.query as object),
        status: 'live',
        limit: 100,
      });
      return catalog.listEvents(query);
    });

    app.get('/events/:id', async (request) => {
      const { id } = parse(idParam, request.params);
      return catalog.getEvent(id);
    });

    app.get('/selections', async (request) => {
      const { ids } = parse(sharedSelectionsQuery, request.query);
      return { selections: await catalog.sharedSelections(ids) };
    });

    app.get('/events/:id/incidents', async (request) => {
      const { id } = parse(idParam, request.params);
      return insights.incidents(id);
    });

    app.get('/events/:id/insights', async (request) => {
      const { id } = parse(idParam, request.params);
      return insights.insights(id);
    });

    app.get('/events/:id/markets', async (request) => {
      const { id } = parse(idParam, request.params);
      return catalog.getMarkets(id);
    });
  };
}
