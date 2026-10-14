import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TICKET_EVENTS,
  USER_FIELDS,
  ZendeskError,
  appValues,
  buildTicket,
  buildUser,
  connectionError,
  createContext,
  createTicket,
  createUserFields,
  existingTicket,
  customerName,
  customerUrl,
  errorMessage,
  formatPhone,
  getAccessToken,
  getRecentOrders,
  getSettings,
  getUserFieldKeys,
  handleError,
  isCustomerChange,
  loadSettings,
  missingSettings,
  orderFieldKeys,
  orderFields,
  orderLine,
  parseSubdomain,
  parseTags,
  syncAccount,
  ticketField,
  ticketText,
  ticketUrl,
  upsertUser,
  userForAccount,
  zendeskRequest,
} from "../../functions/lib/zendesk";
import {
  ADMIN_URL,
  allFields,
  callOf,
  callsTo,
  makeAccount,
  makeContext,
  makeOrder,
  makeReturn,
  makeSettings,
  makeSwell,
  mockZendesk,
  rawSettings,
} from "../helpers/zendesk-fixtures";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const allKeys = new Set(USER_FIELDS.map((field) => field.key));

describe("appValues", () => {
  it("nests values under the app id", () => {
    expect(appValues({ a: 1 })).toEqual({ $app: { zendesk: { a: 1 } } });
    expect(appValues({ a: 1 }, "zendesk_dev")).toEqual({ $app: { zendesk_dev: { a: 1 } } });
  });
});

describe("ZendeskError", () => {
  it("formats the message and knows what to retry", () => {
    const err = new ZendeskError(422, "RecordInvalid", "Email is invalid");
    expect(err.message).toBe("Zendesk 422 RecordInvalid: Email is invalid");
    expect([0, 429, 500, 503].map((s) => new ZendeskError(s, undefined, "x").retryable)).toEqual([true, true, true, true]);
    expect([400, 401, 403, 404, 422].map((s) => new ZendeskError(s, undefined, "x").retryable)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("parseSubdomain", () => {
  it("accepts the subdomain, host or URL", () => {
    expect(parseSubdomain("acme")).toBe("acme");
    expect(parseSubdomain(" Acme.zendesk.com ")).toBe("acme");
    expect(parseSubdomain("https://acme-help.zendesk.com/agent")).toBe("acme-help");
  });

  it("rejects anything else", () => {
    expect(parseSubdomain("acme.example.com")).toBe("");
    expect(parseSubdomain("-bad")).toBe("");
    expect(parseSubdomain(undefined)).toBe("");
  });
});

describe("parseTags", () => {
  it("makes Zendesk tags from a comma-separated list", () => {
    expect(parseTags(" Swell, VIP customer ,,swell")).toEqual(["swell", "vip_customer"]);
    expect(parseTags(["a", " b "])).toEqual(["a", "b"]);
    expect(parseTags(null)).toEqual([]);
  });
});

describe("getSettings", () => {
  it("applies defaults", () => {
    expect(getSettings({ zendesk: rawSettings })).toEqual({
      subdomain: "acme",
      client_id: "swell_app",
      client_secret: "zd-secret",
      enabled: true,
      sync_customers: true,
      order_context: true,
      recent_orders: 5,
      ticket_payment_failed: true,
      ticket_canceled: false,
      ticket_refunded: false,
      ticket_return: true,
      ticket_priority: "normal",
      ticket_tags: ["swell"],
      ticket_group_id: null,
    });
  });

  it("reads saved values and clamps them", () => {
    const settings = getSettings({
      zendesk: { ...rawSettings, recent_orders: 50, ticket_priority: "urgent", ticket_tags: "", ticket_group_id: " 360001 " },
    });
    expect(settings).toMatchObject({ recent_orders: 10, ticket_priority: "urgent", ticket_tags: [], ticket_group_id: 360001 });
    expect(getSettings({ zendesk: { recent_orders: 0, ticket_priority: "asap", ticket_group_id: "abc" } })).toMatchObject({
      recent_orders: 5,
      ticket_priority: "normal",
      ticket_group_id: null,
    });
  });
});

describe("missingSettings / loadSettings", () => {
  it("lists what is missing", () => {
    expect(missingSettings(getSettings({}))).toEqual(["Zendesk subdomain", "OAuth client identifier", "OAuth client secret"]);
    expect(missingSettings(makeSettings())).toEqual([]);
  });

  it("returns settings only when enabled and complete", async () => {
    expect(await loadSettings({ settings: async () => ({ zendesk: rawSettings }) })).toMatchObject({ subdomain: "acme" });
    expect(await loadSettings({ settings: async () => ({ zendesk: { ...rawSettings, enabled: false } }) })).toBeNull();
    expect(await loadSettings({ settings: async () => ({ zendesk: { subdomain: "acme" } }) })).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("Zendesk: missing OAuth client identifier, OAuth client secret in app settings");
  });
});

describe("errorMessage", () => {
  it("reads every Zendesk error shape", () => {
    expect(errorMessage({ error: "invalid_client", error_description: "Client authentication failed" }, "x")).toEqual({
      code: "invalid_client",
      message: "Client authentication failed",
    });
    expect(
      errorMessage(
        { error: "RecordInvalid", description: "Record validation errors", details: { email: [{ description: "Email is invalid" }] } },
        "x",
      ),
    ).toEqual({ code: "RecordInvalid", message: "Email is invalid" });
    expect(errorMessage({ error: { title: "Forbidden", message: "You do not have access" } }, "x")).toEqual({
      code: "Forbidden",
      message: "You do not have access",
    });
    expect(errorMessage({ error: "InvalidEndpoint", description: "Not found" }, "x")).toEqual({
      code: "InvalidEndpoint",
      message: "Not found",
    });
    expect(errorMessage(null, "Bad Gateway")).toEqual({ message: "Bad Gateway" });
  });
});

describe("zendeskRequest", () => {
  it("calls the subdomain with the bearer token and JSON body", async () => {
    const fetchMock = mockZendesk();
    await zendeskRequest(makeSettings(), "tok", "POST", "/api/v2/users/create_or_update", { user: {} }, { "Idempotency-Key": "k" });
    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.url).toBe("https://acme.zendesk.com/api/v2/users/create_or_update");
    expect(call.headers).toMatchObject({ authorization: "Bearer tok", "content-type": "application/json", "Idempotency-Key": "k" });
  });

  it("records the refused call without the query string", async () => {
    mockZendesk({ userFields: { status: 403, body: { error: "Forbidden" } } });
    const err = await zendeskRequest(makeSettings(), "t", "GET", "/api/v2/user_fields?page[size]=100").catch((e) => e);
    expect(err).toMatchObject({ status: 403, endpoint: "GET /api/v2/user_fields" });
    expect(err.detail).toBe("Zendesk 403 Forbidden: Forbidden (GET /api/v2/user_fields)");
  });

  it("throws ZendeskError with Zendesk's message", async () => {
    mockZendesk({ upsert: { status: 422, body: { error: "RecordInvalid", details: { email: [{ description: "Email is invalid" }] } } } });
    await expect(zendeskRequest(makeSettings(), "t", "POST", "/api/v2/users/create_or_update", {})).rejects.toMatchObject({
      status: 422,
      message: "Zendesk 422 RecordInvalid: Email is invalid",
    });
  });

  it("turns network failures into status 0", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
    await expect(zendeskRequest(makeSettings(), "t", "GET", "/x")).rejects.toMatchObject({ status: 0, retryable: true });
  });

  it("returns null for empty bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    expect(await zendeskRequest(makeSettings(), "t", "PUT", "/x")).toBeNull();
  });
});

describe("getAccessToken / createContext", () => {
  it("uses the client credentials grant", async () => {
    const fetchMock = mockZendesk();
    expect(await getAccessToken(makeSettings())).toBe("token_1");
    const call = callOf(fetchMock.mock.calls[0]);
    expect(call.url).toBe("https://acme.zendesk.com/oauth/tokens");
    expect(call.headers).not.toHaveProperty("authorization");
    expect(call.body).toEqual({
      grant_type: "client_credentials",
      client_id: "swell_app",
      client_secret: "zd-secret",
      scope: "read write",
      expires_in: 1800,
    });
  });

  it("fails without a token in the response", async () => {
    mockZendesk({ token: { status: 201, body: {} } });
    await expect(getAccessToken(makeSettings())).rejects.toThrow("no access token");
  });

  it("builds the context with a trimmed admin URL", async () => {
    mockZendesk();
    expect(await createContext(makeSettings(), `${ADMIN_URL}/`)).toMatchObject({ token: "token_1", adminUrl: ADMIN_URL });
  });
});

describe("user fields", () => {
  it("reads keys across pages", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user_fields: [{ key: "a" }],
            meta: { has_more: true },
            links: { next: "https://acme.zendesk.com/api/v2/user_fields?page[after]=x&page[size]=100" },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_fields: [{ key: "b" }], meta: { has_more: false } })));
    expect([...(await getUserFieldKeys(makeContext()))]).toEqual(["a", "b"]);
  });

  it("creates only the missing fields", async () => {
    const fetchMock = mockZendesk({
      userFields: { status: 200, body: { user_fields: allFields.slice(0, 2), meta: { has_more: false } } },
    });
    const result = await createUserFields(makeContext());
    expect(result).toEqual({
      created: ["swell_last_order", "swell_recent_orders", "swell_customer_url"],
      existing: ["swell_order_count", "swell_total_spent"],
    });
    const created = callsTo(fetchMock, "/api/v2/user_fields", "POST");
    expect(created[0].body).toEqual({
      user_field: {
        key: "swell_last_order",
        type: "text",
        title: "Swell last order",
        description: "Latest Swell order: number, status, total and date",
        active: true,
      },
    });
  });

  it("only reads keys when order context is on", async () => {
    const fetchMock = mockZendesk();
    expect(await orderFieldKeys(makeContext({ settings: makeSettings({ order_context: false }) }))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await orderFieldKeys(makeContext()))?.size).toBe(5);
  });
});

describe("isCustomerChange", () => {
  it("syncs created accounts and profile changes only", () => {
    expect(isCustomerChange("account.created", {})).toBe(true);
    expect(isCustomerChange("account.updated", { phone: "1" })).toBe(true);
    expect(isCustomerChange("account.updated", { order_count: 4, balance: 0 })).toBe(false);
    expect(isCustomerChange("account.updated", { $app: { zendesk: {} } })).toBe(false);
  });
});

describe("formatPhone / customerName", () => {
  it("formats phones to E.164 or leaves them out", () => {
    expect(formatPhone("(415) 555-2671", "us")).toBe("+14155552671");
    expect(formatPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(formatPhone("12", "US")).toBeUndefined();
    expect(formatPhone(undefined)).toBeUndefined();
  });

  it("falls back from name to parts to the email", () => {
    expect(customerName({ name: "Jane D" })).toBe("Jane D");
    expect(customerName({ first_name: "Jane", last_name: "Doe" })).toBe("Jane Doe");
    expect(customerName({ email: "jane@example.com" })).toBe("jane");
  });
});

describe("order context", () => {
  it("formats an order line", () => {
    expect(orderLine(makeOrder())).toBe("#1042 · complete · 120.00 USD · 2026-10-01");
    expect(orderLine({ id: "o1", grand_total: "x" })).toBe("#o1 · 0.00");
    expect(orderLine(makeOrder(), false)).toBe("#1042 · 120.00 USD · 2026-10-01");
  });

  it("loads the latest orders of the account", async () => {
    const swell = makeSwell();
    await getRecentOrders(swell, "acc_1", 3);
    expect(swell.get).toHaveBeenCalledWith("/orders", {
      where: { account_id: "acc_1" },
      sort: "date_created desc",
      limit: 3,
      fields: "id,number,status,grand_total,currency,date_created",
    });
  });

  it("links to the customer in the dashboard", () => {
    expect(customerUrl(ADMIN_URL, "acc_1")).toBe(`${ADMIN_URL}/customers/acc_1`);
    expect(customerUrl("", "acc_1")).toBeUndefined();
  });

  it("fills only the fields that exist in Zendesk", () => {
    const orders = [makeOrder(), makeOrder({ number: "1041", status: "canceled", date_created: "2026-09-01" })];
    expect(orderFields(makeAccount(), orders, ADMIN_URL, allKeys)).toEqual({
      swell_order_count: 3,
      swell_total_spent: 245.5,
      swell_last_order: "#1042 · complete · 120.00 USD · 2026-10-01",
      swell_recent_orders: "#1042 · complete · 120.00 USD · 2026-10-01\n#1041 · canceled · 120.00 USD · 2026-09-01",
      swell_customer_url: `${ADMIN_URL}/customers/acc_1`,
    });
    expect(orderFields(makeAccount(), [], ADMIN_URL, new Set(["swell_order_count"]))).toEqual({ swell_order_count: 3 });
  });
});

describe("buildUser / userForAccount", () => {
  it("maps the account to a Zendesk user", () => {
    expect(buildUser(makeAccount())).toEqual({
      external_id: "acc_1",
      email: "jane@example.com",
      name: "Jane Doe",
      phone: "+14155552671",
      skip_verify_email: true,
    });
    expect(buildUser(makeAccount({ phone: "bad" }), { swell_order_count: 1 })).toEqual({
      external_id: "acc_1",
      email: "jane@example.com",
      name: "Jane Doe",
      skip_verify_email: true,
      user_fields: { swell_order_count: 1 },
    });
  });

  it("adds order context when it's on and the fields exist", async () => {
    const swell = makeSwell();
    const user = await userForAccount(swell, makeAccount(), makeContext(), allKeys);
    expect(user.user_fields.swell_last_order).toBe("#1042 · complete · 120.00 USD · 2026-10-01");
    expect(swell.get).toHaveBeenCalledTimes(1);
  });

  it("skips Swell order lookups when they aren't needed", async () => {
    const swell = makeSwell();
    expect((await userForAccount(swell, makeAccount(), makeContext(), new Set(["swell_order_count"]))).user_fields).toEqual({
      swell_order_count: 3,
    });
    expect(await userForAccount(swell, makeAccount(), makeContext(), new Set())).not.toHaveProperty("user_fields");
    expect(
      await userForAccount(swell, makeAccount(), makeContext({ settings: makeSettings({ order_context: false }) }), allKeys),
    ).not.toHaveProperty("user_fields");
    expect(swell.get).not.toHaveBeenCalled();
  });
});

describe("upsertUser / syncAccount", () => {
  it("creates or updates the user and returns its id", async () => {
    const fetchMock = mockZendesk();
    expect(await upsertUser(makeContext(), { email: "a@b.c" })).toBe(501);
    expect(callsTo(fetchMock, "/api/v2/users/create_or_update")[0].body).toEqual({ user: { email: "a@b.c" } });
  });

  it("syncs the account with order context", async () => {
    const fetchMock = mockZendesk();
    expect(await syncAccount(makeSwell(), makeAccount(), makeContext())).toBe(true);
    const [upsert] = callsTo(fetchMock, "/api/v2/users/create_or_update");
    expect(upsert.body.user.user_fields.swell_order_count).toBe(3);
  });

  it("skips accounts without an email", async () => {
    const fetchMock = mockZendesk();
    expect(await syncAccount(makeSwell(), makeAccount({ email: "" }), makeContext())).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("tickets", () => {
  it("maps events to kinds and settings", () => {
    expect(TICKET_EVENTS["order.payment_failed"]).toEqual({ kind: "payment_failed", setting: "ticket_payment_failed" });
    expect(TICKET_EVENTS["return.created"]).toEqual({ kind: "return", setting: "ticket_return" });
    expect(ticketField("canceled")).toBe("zendesk_ticket_canceled");
    expect(ticketField("return")).toBe("zendesk_ticket");
    expect(ticketUrl(makeSettings(), 77)).toBe("https://acme.zendesk.com/agent/tickets/77");
  });

  it("writes the internal note for an order event", () => {
    expect(ticketText("payment_failed", makeOrder(), ADMIN_URL)).toEqual({
      subject: "Payment failed for order #1042",
      body: [
        "Payment failed for order #1042.",
        "",
        "Customer: Jane Doe <jane@example.com>",
        "Order: #1042 · 120.00 USD · 2026-10-01",
        "",
        "Items:",
        "- 2 × Trail Shirt (Large)",
        "- 1 × Cap",
        "",
        `Swell order: ${ADMIN_URL}/orders/ord_1`,
      ].join("\n"),
    });
    expect(ticketText("refunded", makeOrder({ refund_total: 30 }), "").body).toContain("Refunded: 30.00 USD");
    expect(ticketText("canceled", makeOrder(), "").subject).toBe("Order #1042 was canceled");
  });

  it("sends the same note when the order status changes before a retry", () => {
    expect(ticketText("canceled", makeOrder({ status: "canceled" }), ADMIN_URL)).toEqual(
      ticketText("canceled", makeOrder({ status: "complete" }), ADMIN_URL),
    );
  });

  it("lists the returned items and the reason", () => {
    const { subject, body } = ticketText("return", makeOrder(), ADMIN_URL, makeReturn());
    expect(subject).toBe("Return requested for order #1042");
    expect(body).toContain("Return: #R-7\nReason: damaged\nNotes: Seam came apart");
    expect(body).toContain("Returned items:\n- 1 × Trail Shirt (Large)");
    expect(body).not.toContain("Cap");
  });

  it("builds the ticket with the requester, tags, priority and group", () => {
    const ctx = makeContext({ settings: makeSettings({ ticket_priority: "high", ticket_tags: ["swell", "vip"], ticket_group_id: 12 }) });
    expect(buildTicket("canceled", makeOrder(), ctx)).toMatchObject({
      subject: "Order #1042 was canceled",
      comment: { public: false },
      requester: { name: "Jane Doe", email: "jane@example.com" },
      priority: "high",
      tags: ["swell", "vip", "swell_canceled"],
      external_id: "swell-canceled-ord_1",
      group_id: 12,
    });
    expect(buildTicket("return", makeOrder(), makeContext(), makeReturn()).external_id).toBe("swell-return-ret_1");
    expect(buildTicket("canceled", makeOrder(), makeContext())).not.toHaveProperty("group_id");
  });

  it("creates the ticket with an idempotency key and saves its link", async () => {
    const fetchMock = mockZendesk();
    const swell = makeSwell();

    const result = await createTicket(swell, "payment_failed", makeOrder(), makeContext());

    expect(result).toEqual({ status: "created", url: "https://acme.zendesk.com/agent/tickets/77" });
    const [call] = callsTo(fetchMock, "/api/v2/tickets");
    expect(call.headers["Idempotency-Key"]).toBe("swell-payment_failed-ord_1");
    expect(swell.put).toHaveBeenCalledWith("/orders/ord_1", {
      $app: { zendesk: { zendesk_ticket_payment_failed: "https://acme.zendesk.com/agent/tickets/77" } },
    });
  });

  it("saves a return ticket on the return", async () => {
    mockZendesk();
    const swell = makeSwell();
    await createTicket(swell, "return", makeOrder(), makeContext(), { ret: makeReturn(), appId: "zendesk_dev" });
    expect(swell.put).toHaveBeenCalledWith("/returns/ret_1", {
      $app: { zendesk_dev: { zendesk_ticket: "https://acme.zendesk.com/agent/tickets/77" } },
    });
  });

  it("finds the ticket already created for a record", () => {
    const order = makeOrder({ $app: { zendesk: { zendesk_ticket_canceled: "u" }, other: { zendesk_ticket_refunded: "x" } } });
    expect(existingTicket(order, "canceled")).toBe("u");
    expect(existingTicket(order, "refunded")).toBeUndefined();
    expect(existingTicket(order, "refunded", "other")).toBe("x");
  });

  it("skips records that already have a ticket, and customers without email", async () => {
    const fetchMock = mockZendesk();
    const done = makeOrder({ $app: { zendesk: { zendesk_ticket_canceled: "https://acme.zendesk.com/agent/tickets/1" } } });
    expect(await createTicket(makeSwell(), "canceled", done, makeContext())).toEqual({
      status: "skipped",
      reason: "ticket already created",
    });
    expect(await createTicket(makeSwell(), "canceled", makeOrder({ account: {} }), makeContext())).toEqual({
      status: "skipped",
      reason: "no customer email",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs, not throws, when the link can't be saved", async () => {
    mockZendesk();
    const swell = makeSwell();
    swell.put.mockRejectedValue(new Error("Swell down"));
    expect((await createTicket(swell, "canceled", makeOrder(), makeContext())).status).toBe("created");
    expect(errorSpy).toHaveBeenCalledWith(
      "Zendesk: ticket https://acme.zendesk.com/agent/tickets/77 not saved on orders ord_1:",
      "Swell down",
    );
  });

  it("throws Zendesk errors to the caller", async () => {
    mockZendesk({ ticket: { status: 503, body: { error: "Unavailable" } } });
    await expect(createTicket(makeSwell(), "canceled", makeOrder(), makeContext())).rejects.toMatchObject({ status: 503 });
  });
});

describe("handleError", () => {
  it("rethrows retryable Zendesk errors and logs the rest", () => {
    const retry = new ZendeskError(429, undefined, "slow down");
    expect(() => handleError("x", retry)).toThrow(retry);
    handleError("sync", new ZendeskError(422, undefined, "bad"));
    handleError("sync", "boom");
    expect(errorSpy).toHaveBeenCalledWith("Zendesk: sync failed:", "Zendesk 422: bad");
    expect(errorSpy).toHaveBeenCalledWith("Zendesk: sync failed:", "boom");
  });
});

describe("connectionError", () => {
  const settings = makeSettings();

  it("explains credential, client type and subdomain problems", () => {
    expect(connectionError(new ZendeskError(401, "invalid_client", "x"), settings)).toMatch(
      /^Zendesk rejected the OAuth client identifier or secret/,
    );
    expect(connectionError(new ZendeskError(400, "unauthorized_client", "x"), settings)).toBe(
      "Zendesk does not allow this client to get tokens with its secret. Set the OAuth client type to Confidential.",
    );
    expect(connectionError(new ZendeskError(404, undefined, "x", "POST /oauth/tokens"), settings)).toBe(
      "No Zendesk account found at acme.zendesk.com. Check the Zendesk subdomain.",
    );
    // a 404 from another call isn't a wrong subdomain
    expect(connectionError(new ZendeskError(404, undefined, "Not found", "GET /api/v2/user_fields"), settings)).toBe(
      "Zendesk request failed: Zendesk 404: Not found (GET /api/v2/user_fields)",
    );
    expect(connectionError(new ZendeskError(0, "network_error", "getaddrinfo ENOTFOUND acme.zendesk.com"), settings)).toBe(
      "acme.zendesk.com could not be reached. Check the Zendesk subdomain.",
    );
  });

  it("explains a refused call and missing scopes", () => {
    expect(connectionError(new ZendeskError(403, "Forbidden", "Forbidden", "POST /api/v2/users/create_or_update_many"), settings)).toBe(
      "Zendesk refused POST /api/v2/users/create_or_update_many (403 Forbidden). Check that the OAuth client belongs " +
        "to a Zendesk admin and allows read and write access, and that Zendesk IP restrictions are off (Swell has no " +
        "fixed IP addresses).",
    );
    expect(connectionError(new ZendeskError(400, "invalid_scope", "x"), settings)).toBe(
      "Zendesk did not grant the read and write scopes. Check the OAuth client in Admin Center.",
    );
  });

  it("says try again only for temporary failures", () => {
    expect(connectionError(new ZendeskError(503, undefined, "down"), settings)).toBe(
      "Zendesk request failed, try again later: Zendesk 503: down",
    );
    expect(connectionError(new ZendeskError(422, undefined, "bad"), settings)).toBe("Zendesk request failed: Zendesk 422: bad");
    expect(connectionError(new Error("boom"), settings)).toBe("Zendesk request failed: boom");
  });
});
