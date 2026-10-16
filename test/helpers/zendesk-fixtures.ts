import { vi } from "vitest";
import { USER_FIELDS, getSettings, type ZendeskContext, type ZendeskSettings } from "../../functions/lib/zendesk";

// raw settings as returned by swell.settings()
export const rawSettings = {
  subdomain: "acme",
  client_id: "swell_app",
  client_secret: "zd-secret",
};

export function makeSettings(overrides: Partial<ZendeskSettings> = {}): ZendeskSettings {
  return { ...getSettings({ zendesk: rawSettings }), ...overrides };
}

export const ADMIN_URL = "https://shop.swell.store/admin";

export function makeContext(overrides: Partial<ZendeskContext> = {}): ZendeskContext {
  return { settings: makeSettings(), token: "token_1", adminUrl: ADMIN_URL, ...overrides };
}

export function makeAccount(overrides: Record<string, any> = {}) {
  return {
    id: "acc_1",
    email: "jane@example.com",
    first_name: "Jane",
    last_name: "Doe",
    name: "Jane Doe",
    phone: "(415) 555-2671",
    shipping: { country: "US" },
    order_count: 3,
    order_value: 245.5,
    ...overrides,
  };
}

export function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: "ord_1",
    number: "1042",
    status: "complete",
    grand_total: 120,
    currency: "USD",
    date_created: "2026-10-01T10:00:00.000Z",
    account_id: "acc_1",
    account: makeAccount(),
    items: [
      { id: "item_1", quantity: 2, product: { name: "Trail Shirt" }, variant: { name: "Large" } },
      { id: "item_2", quantity: 1, product: { name: "Cap" } },
    ],
    ...overrides,
  };
}

export function makeReturn(overrides: Record<string, any> = {}) {
  return {
    id: "ret_1",
    number: "R-7",
    order_id: "ord_1",
    reason_code: "damaged",
    notes: "Seam came apart",
    items: [{ order_item_id: "item_1", quantity: 1 }],
    ...overrides,
  };
}

export const allFields = USER_FIELDS.map((field) => ({ key: field.key, title: field.title }));

type Reply = { status: number; body?: any } | Error;

export interface Routes {
  token?: Reply;
  me?: Reply;
  userFields?: Reply;
  createField?: Reply;
  upsert?: Reply;
  bulk?: Reply;
  job?: Reply | Reply[];
  ticket?: Reply;
}

function respond(reply: Reply): Response {
  if (reply instanceof Error) {
    throw reply;
  }
  const text = reply.body === undefined ? null : JSON.stringify(reply.body);
  return new Response(text, { status: reply.status });
}

// Mocks global fetch by Zendesk endpoint; job replies are taken in order (the last one repeats)
export function mockZendesk(routes: Routes = {}) {
  const jobs = Array.isArray(routes.job) ? [...routes.job] : [routes.job ?? jobReply("completed", [{ status: "Created" }])];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method || "GET";
    if (url.endsWith("/oauth/tokens")) {
      return respond(routes.token ?? { status: 201, body: { access_token: "token_1", token_type: "bearer", expires_in: 1800 } });
    }
    if (url.endsWith("/api/v2/users/me")) {
      return respond(routes.me ?? { status: 200, body: { user: { id: 1, name: "Ada Admin", email: "ada@acme.com", role: "admin" } } });
    }
    if (url.includes("/api/v2/user_fields") && method === "GET") {
      return respond(routes.userFields ?? { status: 200, body: { user_fields: allFields, meta: { has_more: false } } });
    }
    if (url.endsWith("/api/v2/user_fields") && method === "POST") {
      return respond(routes.createField ?? { status: 201, body: { user_field: { id: 9 } } });
    }
    if (url.endsWith("/api/v2/users/create_or_update")) {
      return respond(routes.upsert ?? { status: 200, body: { user: { id: 501 } } });
    }
    if (url.endsWith("/api/v2/users/create_or_update_many")) {
      return respond(routes.bulk ?? { status: 200, body: { job_status: { id: "job_1", status: "queued" } } });
    }
    if (url.includes("/api/v2/job_statuses/")) {
      return respond(jobs.length > 1 ? jobs.shift()! : jobs[0]);
    }
    if (url.endsWith("/api/v2/tickets")) {
      return respond(routes.ticket ?? { status: 201, body: { ticket: { id: 77 } } });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
}

export function jobReply(status: string, results: any[] = []) {
  return { status: 200, body: { job_status: { id: "job_1", status, results } } };
}

// method, url, headers and parsed body of a fetch call
export function callOf(call: any[]) {
  const [url, init] = call;
  return {
    method: init?.method,
    url: String(url),
    headers: init?.headers || {},
    body: init?.body ? JSON.parse(init.body) : undefined,
  };
}

// fetch calls to an endpoint ending with the path
export function callsTo(fetchMock: { mock: { calls: any[][] } }, path: string, method?: string) {
  return fetchMock.mock.calls
    .map(callOf)
    .filter((call) => call.url.split("?")[0].endsWith(path) && (!method || call.method === method));
}

// Swell client mock: get answers by path, put records writes
export function makeSwell(records: Record<string, any> = {}, settings: any = rawSettings) {
  return {
    get: vi.fn(async (path: string, query?: any) => {
      if (path === "/orders" && query?.where?.account_id) {
        return { results: records.recentOrders ?? [makeOrder()] };
      }
      if (path === "/accounts/{id}") return "account" in records ? records.account : makeAccount();
      if (path === "/orders/{id}") return "order" in records ? records.order : makeOrder();
      if (path === "/returns/{id}") return "ret" in records ? records.ret : makeReturn();
      if (path === "/returns" && query?.where?.order_id) return { results: records.orderReturns ?? ["ret" in records ? records.ret : makeReturn()] };
      if (path === "/accounts") return { results: records.accounts ?? [] };
      return null;
    }),
    put: vi.fn().mockResolvedValue({}),
    settings: vi.fn().mockResolvedValue({ zendesk: settings }),
  };
}
