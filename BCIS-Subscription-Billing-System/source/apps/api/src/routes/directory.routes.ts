import type { FastifyInstance } from "fastify";
import {
  paginationSchema,
  searchSchema,
  upsertAddressSchema,
  upsertCollectorSchema,
  upsertCollectionAreaSchema,
  upsertCollectionRouteSchema,
  upsertPlanSchema,
  upsertServiceAccountSchema,
  upsertSubscriberSchema,
  updateSubscriberSchema,
  changePlanSchema
} from "@bcis/shared";

import { getDatabase, inTransaction } from "../db/client.js";
import { validationFailed } from "../services/errors.js";
import {
  accountCountsByStatus,
  addSubscriberAddress,
  billablePeriods,
  changeServiceAccountPlan,
  createPlan,
  createServiceAccount,
  createSubscriber,
  getServiceAccount,
  getSubscriber,
  listCollectionAreas,
  listCollectionRoutes,
  listCollectors,
  listPlans,
  listServiceAccounts,
  listServiceDevices,
  listServiceEvents,
  listSubscriberAddresses,
  listTechnicians,
  searchSubscribers,
  updatePlan,
  updateSubscriber,
  upsertCollectionArea,
  upsertCollectionRoute,
  upsertCollector,
  upsertTechnician
} from "../services/directory.js";
import { actorOf, authorize } from "../http/guards.js";

/**
 * Directory endpoints: plans, collection topology, subscribers and service
 * accounts (§3.1–§3.3).
 *
 * Read routes take the narrower `subscriber.view` / `service.view`
 * permissions; anything that writes takes the `*.manage` counterpart. Splitting
 * them is what lets a collector see the accounts on their route without also
 * being able to change a subscriber's address.
 */

/** Turns a Zod failure into the shared 400 envelope. */
function fail(error: { issues: Array<{ path: PropertyKey[]; message: string }> }, what: string): never {
  throw validationFailed(what, {
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
  });
}

function page(query: unknown): { page: number; pageSize: number } {
  const parsed = paginationSchema.safeParse(query ?? {});
  return parsed.success ? parsed.data : { page: 1, pageSize: 25 };
}

export async function registerDirectoryRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDatabase();

  // ---- Plans ---------------------------------------------------------------

  app.get("/plans", { preHandler: authorize("service.view") }, async (request) => {
    const activeOnly = (request.query as { activeOnly?: string }).activeOnly === "true";
    return { items: await listPlans(db, { activeOnly }) };
  });

  app.post("/plans", { preHandler: authorize("plan.manage") }, async (request, reply) => {
    const parsed = upsertPlanSchema.safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The plan could not be saved.");
    }
    const plan = await inTransaction((tx) => createPlan(tx, parsed.data, actorOf(request)));
    return reply.status(201).send({ id: plan.id, code: plan.code });
  });

  app.put("/plans/:id", { preHandler: authorize("plan.manage") }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = upsertPlanSchema.partial().safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The plan could not be updated.");
    }
    const plan = await inTransaction((tx) => updatePlan(tx, id, parsed.data, actorOf(request)));
    return { id: plan.id, code: plan.code };
  });

  // ---- Collection topology -------------------------------------------------

  app.get("/collection-areas", { preHandler: authorize("collection.view") }, async (request) => {
    const activeOnly = (request.query as { activeOnly?: string }).activeOnly === "true";
    return { items: await listCollectionAreas(db, { activeOnly }) };
  });

  // Areas, routes and collectors are operational reference data that must exist
  // before a subscriber can be assigned to them, so they are maintained under
  // `settings.manage` rather than a collection permission — a collector recording
  // a doorstep collection has no business editing the route list.
  app.post("/collection-areas", { preHandler: authorize("settings.manage") }, async (request, reply) => {
    const parsed = upsertCollectionAreaSchema.safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The collection area could not be saved.");
    }
    const area = await inTransaction((tx) => upsertCollectionArea(tx, parsed.data, actorOf(request)));
    return reply.status(201).send({ id: area.id, code: area.code });
  });

  app.get("/collection-routes", { preHandler: authorize("collection.view") }, async (request) => {
    const { areaId } = request.query as { areaId?: string };
    return { items: await listCollectionRoutes(db, areaId) };
  });

  app.post("/collection-routes", { preHandler: authorize("settings.manage") }, async (request, reply) => {
    const parsed = upsertCollectionRouteSchema.safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The collection route could not be saved.");
    }
    const route = await inTransaction((tx) => upsertCollectionRoute(tx, parsed.data));
    return reply.status(201).send({ id: route.id, code: route.code });
  });

  app.get("/collectors", { preHandler: authorize("collection.view") }, async (request) => {
    const activeOnly = (request.query as { activeOnly?: string }).activeOnly === "true";
    return { items: await listCollectors(db, { activeOnly }) };
  });

  app.post("/collectors", { preHandler: authorize("settings.manage") }, async (request, reply) => {
    const parsed = upsertCollectorSchema.safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The collector could not be saved.");
    }
    const collector = await inTransaction((tx) => upsertCollector(tx, parsed.data));
    return reply.status(201).send({ id: collector.id, code: collector.code });
  });

  app.get("/technicians", { preHandler: authorize("service.view") }, async () => ({
    items: await listTechnicians(db)
  }));

  app.post("/technicians", { preHandler: authorize("service.manage") }, async (request, reply) => {
    const parsed = upsertCollectorSchema.safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The technician could not be saved.");
    }
    const technician = await inTransaction((tx) => upsertTechnician(tx, parsed.data));
    return reply.status(201).send({ id: technician.id, code: technician.code });
  });

  // ---- Subscribers ---------------------------------------------------------

  // The single global search box (§3.2). Accepts an account number, name,
  // contact number, address, or a receipt / invoice / GCash reference.
  app.get("/subscribers/search", { preHandler: authorize("subscriber.view") }, async (request) => {
    const parsed = searchSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      fail(parsed.error, "The search could not be run.");
    }
    return searchSubscribers(db, parsed.data);
  });

  app.get("/subscribers/:id", { preHandler: authorize("subscriber.view") }, async (request) => {
    const { id } = request.params as { id: string };
    const subscriber = await getSubscriber(db, id);
    return { ...subscriber, addresses: await listSubscriberAddresses(db, id) };
  });

  app.post("/subscribers", { preHandler: authorize("subscriber.manage") }, async (request, reply) => {
    const parsed = upsertSubscriberSchema.safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The subscriber could not be saved.");
    }
    const subscriber = await inTransaction((tx) => createSubscriber(tx, parsed.data, actorOf(request)));
    return reply.status(201).send({ id: subscriber.id, accountNumber: subscriber.accountNumber });
  });

  app.put("/subscribers/:id", { preHandler: authorize("subscriber.manage") }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateSubscriberSchema.safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The subscriber could not be updated.");
    }
    const subscriber = await inTransaction((tx) => updateSubscriber(tx, id, parsed.data, actorOf(request)));
    return { id: subscriber.id, accountNumber: subscriber.accountNumber };
  });

  app.post("/subscribers/:id/addresses", { preHandler: authorize("subscriber.manage") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = upsertAddressSchema.safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The address could not be saved.");
    }
    const address = await inTransaction((tx) => addSubscriberAddress(tx, id, parsed.data));
    return reply.status(201).send({ id: address.id, label: address.label });
  });

  // ---- Service accounts ----------------------------------------------------

  app.get("/service-accounts", { preHandler: authorize("service.view") }, async (request) => {
    const base = page(request.query);
    const query = { ...(request.query as Record<string, string>), ...base };
    return listServiceAccounts(db, {
      ...query,
      page: Number(query.page),
      pageSize: Number(query.pageSize)
    });
  });

  app.get("/service-accounts/:id", { preHandler: authorize("service.view") }, async (request) => {
    const { id } = request.params as { id: string };
    return getServiceAccount(db, id);
  });

  app.get("/service-accounts/:id/events", { preHandler: authorize("service.view") }, async (request) => {
    const { id } = request.params as { id: string };
    return { items: await listServiceEvents(db, id) };
  });

  app.get("/service-accounts/:id/devices", { preHandler: authorize("service.view") }, async (request) => {
    const { id } = request.params as { id: string };
    return { items: await listServiceDevices(db, id) };
  });

  app.post("/service-accounts", { preHandler: authorize("service.manage") }, async (request, reply) => {
    const parsed = upsertServiceAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The service account could not be created.");
    }
    const account = await inTransaction((tx) => createServiceAccount(tx, parsed.data, actorOf(request)));
    return reply.status(201).send({
      id: account.id,
      serviceAccountNumber: account.serviceAccountNumber
    });
  });

  app.post("/service-accounts/:id/plan-change", { preHandler: authorize("service.manage") }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = changePlanSchema.safeParse(request.body);
    if (!parsed.success) {
      fail(parsed.error, "The plan change could not be scheduled.");
    }
    const account = await inTransaction((tx) =>
      changeServiceAccountPlan(tx, id, parsed.data, actorOf(request))
    );
    return { id: account.id, planId: account.planId, currentRateCentavos: account.currentRateCentavos };
  });

  // The periods this account may be billed for, and which already exist. The
  // billing screen uses this to show exactly which months a generation run
  // would still create.
  app.get("/service-accounts/:id/billable-periods", { preHandler: authorize("billing.view") }, async (request) => {
    const { id } = request.params as { id: string };
    const result = await billablePeriods(db, id);
    return {
      account: result.account,
      existingPeriods: [...result.existingPeriods],
      cycles: result.cycles
    };
  });

  // ---- Dashboard helper ----------------------------------------------------

  app.get("/service-accounts/by-status", { preHandler: authorize("dashboard.view") }, async () => ({
    items: await accountCountsByStatus(db)
  }));
}
