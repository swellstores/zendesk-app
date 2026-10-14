import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import {
  ADMIN_URL,
  allFields,
  callsTo,
  makeOrder,
  makeReturn,
  makeSwell,
  mockZendesk,
  rawSettings,
} from "../helpers/zendesk-fixtures";
import customerSync, { config as customerConfig } from "../../functions/customer-sync";
import orderContext, { config as contextConfig } from "../../functions/order-context";
import orderTickets, { config as ticketsConfig } from "../../functions/order-tickets";
import returnTickets, { config as returnConfig } from "../../functions/return-tickets";
import testConnection, { config as testConfig } from "../../functions/test-connection";
import setupFields, { config as setupConfig } from "../../functions/setup-fields";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(data: Record<string, any>, records: Record<string, any> = {}, settings: any = rawSettings) {
  const swell = makeSwell(records, settings);
  const req = createMockRequest({ data, swell: swell as any, store: { admin_url: ADMIN_URL } as any, appId: "zendesk" });
  return { req, swell };
}

const off = { ...rawSettings, enabled: false };

describe("customer-sync", () => {
  it("subscribes to account events", () => {
    expect(customerConfig.model?.events).toEqual(["account.created", "account.updated"]);
  });

  it("creates or updates the Zendesk user with order context", async () => {
    const fetchMock = mockZendesk();
    const { req, swell } = request({ id: "acc_1", $event: { type: "account.created" } });

    await customerSync(req);

    expect(swell.get).toHaveBeenCalledWith("/accounts/{id}", { id: "acc_1" });
    const [upsert] = callsTo(fetchMock, "/api/v2/users/create_or_update");
    expect(upsert.body.user).toMatchObject({
      external_id: "acc_1",
      email: "jane@example.com",
      user_fields: { swell_customer_url: `${ADMIN_URL}/customers/acc_1` },
    });
  });

  it("ignores updates that don't change the profile", async () => {
    const fetchMock = mockZendesk();
    const { req, swell } = request({ id: "acc_1", order_count: 4, $event: { type: "account.updated" } });
    await customerSync(req);
    expect(swell.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the app or customer sync is off", async () => {
    const fetchMock = mockZendesk();
    await customerSync(request({ id: "acc_1", $event: { type: "account.created" } }, {}, off).req);
    await customerSync(
      request({ id: "acc_1", $event: { type: "account.created" } }, {}, { ...rawSettings, sync_customers: false }).req,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs a missing account", async () => {
    const fetchMock = mockZendesk();
    await customerSync(request({ id: "gone", $event: { type: "account.created" } }, { account: null }).req);
    expect(errorSpy).toHaveBeenCalledWith("Zendesk: account gone not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs rejected users and rethrows outages", async () => {
    mockZendesk({ upsert: { status: 422, body: { error: "RecordInvalid", details: { email: [{ description: "Email is invalid" }] } } } });
    await expect(customerSync(request({ id: "acc_1", $event: { type: "account.created" } }).req)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "Zendesk: sync of account acc_1 failed:",
      "Zendesk 422 RecordInvalid: Email is invalid (POST /api/v2/users/create_or_update)",
    );

    vi.restoreAllMocks();
    mockZendesk({ upsert: { status: 503, body: {} } });
    await expect(customerSync(request({ id: "acc_1", $event: { type: "account.created" } }).req)).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("order-context", () => {
  it("subscribes to order events that change the customer's history", () => {
    expect(contextConfig.model?.events).toEqual([
      "order.submitted",
      "order.paid",
      "order.delivered",
      "order.canceled",
      "order.refunded",
    ]);
  });

  it("refreshes the customer's Zendesk user", async () => {
    const fetchMock = mockZendesk();
    const { req, swell } = request({ id: "ord_1" });

    await orderContext(req);

    expect(swell.get).toHaveBeenCalledWith("/orders/{id}", { id: "ord_1", fields: "id,account_id" });
    expect(swell.get).toHaveBeenCalledWith("/accounts/{id}", { id: "acc_1" });
    const [upsert] = callsTo(fetchMock, "/api/v2/users/create_or_update");
    expect(upsert.body.user.user_fields.swell_order_count).toBe(3);
  });

  it("needs both customer sync and order context", async () => {
    const fetchMock = mockZendesk();
    await orderContext(request({ id: "ord_1" }, {}, { ...rawSettings, order_context: false }).req);
    await orderContext(request({ id: "ord_1" }, {}, { ...rawSettings, sync_customers: false }).req);
    await orderContext(request({ id: "ord_1" }, {}, off).req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips orders without an account", async () => {
    const fetchMock = mockZendesk();
    await orderContext(request({ id: "ord_1" }, { order: makeOrder({ account_id: null }) }).req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs a missing account", async () => {
    mockZendesk();
    await orderContext(request({ id: "ord_1" }, { account: null }).req);
    expect(errorSpy).toHaveBeenCalledWith("Zendesk: account acc_1 of order ord_1 not found");
  });

  it("only fills fields that exist in Zendesk", async () => {
    const fetchMock = mockZendesk({ userFields: { status: 200, body: { user_fields: allFields.slice(0, 1) } } });
    await orderContext(request({ id: "ord_1" }).req);
    expect(callsTo(fetchMock, "/api/v2/users/create_or_update")[0].body.user.user_fields).toEqual({ swell_order_count: 3 });
  });
});

describe("order-tickets", () => {
  it("subscribes to ticket events", () => {
    expect(ticketsConfig.model?.events).toEqual(["order.payment_failed", "order.canceled", "order.refunded"]);
  });

  it("creates a ticket for an event that is turned on", async () => {
    const fetchMock = mockZendesk();
    const { req, swell } = request({ id: "ord_1", $event: { type: "order.payment_failed" } });

    await orderTickets(req);

    expect(swell.get).toHaveBeenCalledWith("/orders/{id}", { id: "ord_1", expand: ["account", "items.product", "items.variant"] });
    const [ticket] = callsTo(fetchMock, "/api/v2/tickets");
    expect(ticket.body.ticket.subject).toBe("Payment failed for order #1042");
    expect(swell.put.mock.calls[0][0]).toBe("/orders/ord_1");
  });

  it("does nothing for events that are off by default or unknown", async () => {
    const fetchMock = mockZendesk();
    await orderTickets(request({ id: "ord_1", $event: { type: "order.canceled" } }).req);
    await orderTickets(request({ id: "ord_1", $event: { type: "order.refunded" } }).req);
    await orderTickets(request({ id: "ord_1", $event: { type: "order.updated" } }).req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows the event toggles", async () => {
    const fetchMock = mockZendesk();
    await orderTickets(
      request({ id: "ord_1", $event: { type: "order.canceled" } }, {}, { ...rawSettings, ticket_canceled: true }).req,
    );
    expect(callsTo(fetchMock, "/api/v2/tickets")[0].body.ticket.tags).toEqual(["swell", "swell_canceled"]);
  });

  it("does nothing when the app is off", async () => {
    const fetchMock = mockZendesk();
    await orderTickets(request({ id: "ord_1", $event: { type: "order.payment_failed" } }, {}, off).req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs a missing order", async () => {
    mockZendesk();
    await orderTickets(request({ id: "gone", $event: { type: "order.payment_failed" } }, { order: null }).req);
    expect(errorSpy).toHaveBeenCalledWith("Zendesk: order gone not found");
  });

  it("skips orders that already have the ticket", async () => {
    const fetchMock = mockZendesk();
    const order = makeOrder({ $app: { zendesk: { zendesk_ticket_payment_failed: "https://acme.zendesk.com/agent/tickets/1" } } });
    await orderTickets(request({ id: "ord_1", $event: { type: "order.payment_failed" } }, { order }).req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows outages so Swell retries with the same idempotency key", async () => {
    mockZendesk({ ticket: { status: 503, body: {} } });
    await expect(orderTickets(request({ id: "ord_1", $event: { type: "order.payment_failed" } }).req)).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("return-tickets", () => {
  it("subscribes to new returns", () => {
    expect(returnConfig.model?.events).toEqual(["return.created"]);
  });

  it("creates a ticket for the return's order", async () => {
    const fetchMock = mockZendesk();
    const { req, swell } = request({ id: "ret_1" });

    await returnTickets(req);

    expect(swell.get).toHaveBeenCalledWith("/returns/{id}", { id: "ret_1" });
    const [ticket] = callsTo(fetchMock, "/api/v2/tickets");
    expect(ticket.body.ticket.subject).toBe("Return requested for order #1042");
    expect(ticket.headers["Idempotency-Key"]).toBe("swell-return-ret_1");
    expect(swell.put.mock.calls[0][0]).toBe("/returns/ret_1");
  });

  it("does nothing when return tickets or the app are off", async () => {
    const fetchMock = mockZendesk();
    await returnTickets(request({ id: "ret_1" }, {}, { ...rawSettings, ticket_return: false }).req);
    await returnTickets(request({ id: "ret_1" }, {}, off).req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs a missing return or order", async () => {
    mockZendesk();
    await returnTickets(request({ id: "gone" }, { ret: null }).req);
    await returnTickets(request({ id: "ret_1" }, { order: null }).req);
    expect(errorSpy).toHaveBeenCalledWith("Zendesk: return gone not found or has no order");
    expect(errorSpy).toHaveBeenCalledWith("Zendesk: order ord_1 of return ret_1 not found");
  });

  it("skips returns that already have a ticket", async () => {
    const fetchMock = mockZendesk();
    const ret = makeReturn({ $app: { zendesk: { zendesk_ticket: "https://acme.zendesk.com/agent/tickets/1" } } });
    await returnTickets(request({ id: "ret_1" }, { ret }).req);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("test-connection", () => {
  it("is a settings action", () => {
    expect(testConfig).toMatchObject({ action: true });
  });

  it("asks for missing settings", async () => {
    const fetchMock = mockZendesk();
    expect(await testConnection(request({}, {}, { subdomain: "acme" }).req)).toEqual({
      message: "Add the OAuth client identifier, OAuth client secret and save the settings first.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the client user and the user fields", async () => {
    mockZendesk();
    expect((await testConnection(request({}).req)).message).toBe(
      "Connected to acme.zendesk.com as Ada Admin (admin). All Swell user fields are set up.",
    );
  });

  it("lists missing fields and warns about non-admin users", async () => {
    mockZendesk({
      me: { status: 200, body: { user: { name: "Al Agent", role: "agent" } } },
      userFields: { status: 200, body: { user_fields: allFields.slice(0, 3) } },
    });
    expect((await testConnection(request({}).req)).message).toBe(
      "Connected to acme.zendesk.com as Al Agent (agent). The OAuth client belongs to a non-admin user, so Create user fields " +
        "will not work. Missing user fields: Swell recent orders, Swell customer. Run Create user fields to add them.",
    );
  });

  it("skips the field check when order context is off", async () => {
    const fetchMock = mockZendesk();
    await testConnection(request({}, {}, { ...rawSettings, order_context: false }).req);
    expect(callsTo(fetchMock, "/api/v2/user_fields")).toHaveLength(0);
  });

  it("works while the app is disabled", async () => {
    mockZendesk();
    expect((await testConnection(request({}, {}, off).req)).message).toMatch(/^Connected to acme.zendesk.com/);
  });

  it("explains rejected credentials", async () => {
    mockZendesk({ token: { status: 401, body: { error: "invalid_client", error_description: "Client authentication failed" } } });
    expect((await testConnection(request({}).req)).message).toMatch(/^Zendesk rejected the OAuth client identifier or secret/);
  });
});

describe("setup-fields", () => {
  it("is a settings action", () => {
    expect(setupConfig).toMatchObject({ action: true });
  });

  it("creates the missing fields", async () => {
    const fetchMock = mockZendesk({ userFields: { status: 200, body: { user_fields: allFields.slice(0, 4) } } });
    expect(await setupFields(request({}).req)).toEqual({
      message: "Created user fields: Swell customer. 4 already existed.",
    });
    expect(callsTo(fetchMock, "/api/v2/user_fields", "POST")).toHaveLength(1);
  });

  it("says when everything exists", async () => {
    mockZendesk();
    expect(await setupFields(request({}).req)).toEqual({ message: "All Swell user fields already exist in Zendesk." });
  });

  it("asks for missing settings", async () => {
    expect((await setupFields(request({}, {}, {}).req)).message).toMatch(/^Add the Zendesk subdomain/);
  });

  it("explains a non-admin client and other errors", async () => {
    mockZendesk({
      userFields: { status: 200, body: { user_fields: [] } },
      createField: { status: 403, body: { error: { title: "Forbidden", message: "You do not have access" } } },
    });
    expect((await setupFields(request({}).req)).message).toBe(
      "Zendesk refused to create user fields. The OAuth client must belong to a Zendesk admin.",
    );

    vi.restoreAllMocks();
    mockZendesk({ token: { status: 500, body: {} } });
    expect((await setupFields(request({}).req)).message).toMatch(/^Zendesk request failed, try again later/);
  });
});
