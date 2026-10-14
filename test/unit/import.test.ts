import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PAGE_SIZE,
  addStats,
  buildUsers,
  countJobResults,
  emptyStats,
  fetchAccounts,
  getJobResult,
  jobErrors,
  submitUsers,
  upsertEach,
} from "../../functions/lib/import";
import ImportCustomers, { JOB_CHECKS, config } from "../../functions/import-customers";
import {
  ADMIN_URL,
  callsTo,
  jobReply,
  makeAccount,
  makeContext,
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

const accounts = (n: number, prefix = "a") =>
  Array.from({ length: n }, (_, i) => makeAccount({ id: `${prefix}${String(i).padStart(3, "0")}`, email: `${prefix}${i}@example.com` }));

describe("emptyStats / addStats", () => {
  it("starts at zero and sums partial stats", () => {
    expect(emptyStats()).toEqual({ created: 0, updated: 0, skipped: 0, failed: 0, pending: 0 });
    expect(addStats({ created: 1, updated: 2, skipped: 3, failed: 4, pending: 5 }, { created: 1, pending: 1 })).toEqual({
      created: 2,
      updated: 2,
      skipped: 3,
      failed: 4,
      pending: 6,
    });
  });
});

describe("fetchAccounts", () => {
  it("pages by id with only the needed fields", async () => {
    const get = vi.fn().mockResolvedValue({ results: [makeAccount()] });
    expect(await fetchAccounts({ get }, null)).toHaveLength(1);
    expect(get).toHaveBeenCalledWith("/accounts", {
      sort: "id asc",
      limit: PAGE_SIZE,
      fields: "id,email,name,first_name,last_name,phone,shipping,billing,order_count,order_value",
    });
    await fetchAccounts({ get }, "abc");
    expect(get.mock.calls[1][1].where).toEqual({ id: { $gt: "abc" } });
  });

  it("returns an empty list for empty responses", async () => {
    expect(await fetchAccounts({ get: vi.fn().mockResolvedValue(null) }, null)).toEqual([]);
  });
});

describe("buildUsers", () => {
  it("builds users and skips accounts without an email", async () => {
    const swell = makeSwell();
    const { users, skipped } = await buildUsers(swell, [...accounts(12), makeAccount({ id: "x", email: "" })], makeContext(), null);
    expect(users).toHaveLength(12);
    expect(skipped).toBe(1);
    expect(swell.get).not.toHaveBeenCalled();
  });

  it("adds order context when field keys are given", async () => {
    const swell = makeSwell();
    const { users } = await buildUsers(swell, accounts(2), makeContext(), new Set(["swell_last_order"]));
    expect(users[0].user_fields.swell_last_order).toMatch(/^#1042/);
    expect(swell.get).toHaveBeenCalledTimes(2);
  });
});

describe("upsertEach", () => {
  it("counts created and updated users from the status", async () => {
    mockZendesk({ upsert: { status: 201, body: { user: { id: 1 } } } });
    expect(await upsertEach(makeContext(), [{ email: "a@b.c" }, { email: "d@e.f" }])).toEqual({ created: 2, updated: 0, failed: 0 });

    vi.restoreAllMocks();
    mockZendesk();
    expect(await upsertEach(makeContext(), [{ email: "a@b.c" }])).toEqual({ created: 0, updated: 1, failed: 0 });
  });

  it("counts rejected users as failed and goes on", async () => {
    mockZendesk({ upsert: { status: 422, body: { error: "RecordInvalid", details: { email: [{ description: "Email is invalid" }] } } } });
    expect(await upsertEach(makeContext(), [{ email: "bad" }])).toEqual({ created: 0, updated: 0, failed: 1 });
    expect(errorSpy).toHaveBeenCalledWith(
      "Zendesk: import of bad failed: Zendesk 422 RecordInvalid: Email is invalid (POST /api/v2/users/create_or_update)",
    );
  });

  it("throws refused, rate-limited and server errors", async () => {
    for (const status of [401, 403, 429, 503]) {
      vi.restoreAllMocks();
      mockZendesk({ upsert: { status, body: {} } });
      await expect(upsertEach(makeContext(), [{ email: "a@b.c" }])).rejects.toMatchObject({ status });
    }
  });
});

describe("submitUsers / job results", () => {
  it("queues one bulk job", async () => {
    const fetchMock = mockZendesk();
    expect(await submitUsers(makeContext(), [{ email: "a@b.c" }])).toBe("job_1");
    expect(callsTo(fetchMock, "/api/v2/users/create_or_update_many")[0].body).toEqual({ users: [{ email: "a@b.c" }] });
  });

  it("fails without a job id", async () => {
    mockZendesk({ bulk: { status: 200, body: {} } });
    await expect(submitUsers(makeContext(), [{}])).rejects.toThrow("did not return a job id");
  });

  it("counts created, updated and failed users", () => {
    const job = {
      status: "completed",
      results: [
        { status: "Created", id: 1 },
        { status: "Updated", id: 2 },
        { index: 2, error: "EmailInvalid", details: "Email is invalid", email: "bad" },
        { status: "Failed", id: 4 },
      ],
    };
    expect(countJobResults(job)).toEqual({ done: true, created: 1, updated: 1, failed: 2 });
    expect(countJobResults({ status: "working" })).toEqual({ done: false, created: 0, updated: 0, failed: 0 });
    expect(jobErrors(job)).toEqual(["bad: Email is invalid"]);
  });

  it("reads the job status and logs user errors when done", async () => {
    mockZendesk({ job: jobReply("completed", [{ index: 0, error: "EmailInvalid", email: "bad" }]) });
    expect(await getJobResult(makeContext(), "job_1")).toEqual({ done: true, created: 0, updated: 0, failed: 1 });
    expect(errorSpy).toHaveBeenCalledWith("Zendesk: import of bad: EmailInvalid");
  });
});

describe("import-customers workflow", () => {
  // step.do runner that calls the callback directly and records step names
  function makeStep() {
    const names: string[] = [];
    const step = {
      do: vi.fn(async (name: string, ...args: any[]) => {
        names.push(name);
        return args[args.length - 1]();
      }),
      sleep: vi.fn(async (name: string) => {
        names.push(name);
      }),
      sleepUntil: vi.fn(),
    };
    return { step: step as unknown as SwellWorkflowStep, names };
  }

  function makeReq(pages: any[][], settings: any = rawSettings) {
    const swell = makeSwell({}, settings);
    const get = swell.get;
    const accountPages = [...pages];
    swell.get = vi.fn(async (path: string, query?: any) =>
      path === "/accounts" ? { results: accountPages.shift() ?? [] } : get(path, query),
    );
    const req = { data: {}, store: { id: "s", admin_url: ADMIN_URL }, swell } as unknown as SwellWorkflowRequest;
    return { req, swell };
  }

  it("is a workflow started by an action", () => {
    expect(config).toMatchObject({ kind: "workflow", action: true });
  });

  it("fails without starting when the app, customer sync or settings are missing", async () => {
    const fetchMock = mockZendesk();
    await expect(new ImportCustomers().run(makeReq([], { ...rawSettings, enabled: false }).req, makeStep().step)).rejects.toThrow(
      "Import not started: the Zendesk app is turned off in its settings.",
    );
    await expect(
      new ImportCustomers().run(makeReq([], { ...rawSettings, sync_customers: false }).req, makeStep().step),
    ).rejects.toThrow("Import not started: Sync customer accounts is off in the app settings.");
    await expect(new ImportCustomers().run(makeReq([], { subdomain: "acme" }).req, makeStep().step)).rejects.toThrow(
      "Import not started: add the OAuth client identifier, OAuth client secret in Apps → Zendesk.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("imports every page and waits for each job", async () => {
    const fetchMock = mockZendesk({
      job: [
        jobReply("working"),
        jobReply("completed", [...Array(98).fill({ status: "Created" }), { status: "Updated" }]),
        jobReply("completed", [{ status: "Created" }]),
      ],
    });
    const full = [...accounts(PAGE_SIZE - 1), makeAccount({ id: "a999", email: "" })];
    const { req, swell } = makeReq([full, accounts(1, "z")]);
    const { step, names } = makeStep();

    const totals = await new ImportCustomers().run(req, step);

    expect(totals).toEqual({ created: 99, updated: 1, skipped: 1, failed: 0, pending: 0 });
    expect(names).toEqual([
      "load settings",
      "page 1",
      "page 1 wait 1",
      "page 1 result 1",
      "page 1 wait 2",
      "page 1 result 2",
      "page 2",
      "page 2 wait 1",
      "page 2 result 1",
    ]);
    expect((swell.get as any).mock.calls.filter((c: any[]) => c[0] === "/accounts")[1][1].where).toEqual({
      id: { $gt: "a999" },
    });
    expect(callsTo(fetchMock, "/api/v2/users/create_or_update_many")[0].body.users).toHaveLength(99);
  });

  it("counts users of a job that doesn't finish as pending", async () => {
    mockZendesk({ job: jobReply("working") });
    const { req } = makeReq([accounts(3)]);
    const { step } = makeStep();

    expect(await new ImportCustomers().run(req, step)).toEqual({ created: 0, updated: 0, skipped: 0, failed: 0, pending: 3 });
    expect((step.sleep as any).mock.calls).toHaveLength(JOB_CHECKS);
  });

  it("counts users a failed job doesn't report on as failed", async () => {
    mockZendesk({ job: jobReply("failed", [{ status: "Created" }]) });
    const { req } = makeReq([accounts(3)]);
    expect(await new ImportCustomers().run(req, makeStep().step)).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 2,
      pending: 0,
    });
  });

  it("stops before the next page when the app is turned off", async () => {
    mockZendesk({ job: jobReply("completed", Array(PAGE_SIZE).fill({ status: "Updated" })) });
    const { req, swell } = makeReq([accounts(PAGE_SIZE), accounts(1, "z")]);
    // load settings, page 1, job result, then off
    swell.settings
      .mockResolvedValueOnce({ zendesk: rawSettings })
      .mockResolvedValueOnce({ zendesk: rawSettings })
      .mockResolvedValueOnce({ zendesk: rawSettings })
      .mockResolvedValue({ zendesk: { ...rawSettings, enabled: false } });

    await expect(new ImportCustomers().run(req, makeStep().step)).rejects.toThrow(
      `Import stopped: the app was turned off in its settings. Before stopping: created 0, updated ${PAGE_SIZE}, ` +
        "skipped 0, failed 0, still processing 0.",
    );
  });

  it("stops checking the Zendesk job when the app is turned off", async () => {
    const fetchMock = mockZendesk({ job: jobReply("working") });
    const { req, swell } = makeReq([accounts(3)]);
    // load settings and page 1 see the app on, the first job check sees it off
    swell.settings
      .mockResolvedValueOnce({ zendesk: rawSettings })
      .mockResolvedValueOnce({ zendesk: rawSettings })
      .mockResolvedValue({ zendesk: { ...rawSettings, enabled: false } });
    const { step, names } = makeStep();

    await expect(new ImportCustomers().run(req, step)).rejects.toThrow(
      "Import stopped: the app was turned off in its settings. Before stopping: created 0, updated 0, skipped 0, " +
        "failed 0, still processing 3.",
    );
    expect(names).toEqual(["load settings", "page 1", "page 1 wait 1", "page 1 result 1"]);
    expect(callsTo(fetchMock, "/api/v2/job_statuses/job_1")).toHaveLength(0);
  });

  it("stops when the secret is removed during the run", async () => {
    const { req, swell } = makeReq([accounts(1)]);
    swell.settings.mockResolvedValueOnce({ zendesk: rawSettings }).mockResolvedValue({ zendesk: { ...rawSettings, client_secret: "" } });
    const fetchMock = mockZendesk();
    await expect(new ImportCustomers().run(req, makeStep().step)).rejects.toThrow(
      "Import stopped: the OAuth client secret was removed from the settings.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends users one by one when Zendesk refuses the bulk job", async () => {
    const fetchMock = mockZendesk({ bulk: { status: 403, body: { error: "Forbidden" } }, upsert: { status: 201, body: { user: { id: 1 } } } });
    const { step, names } = makeStep();

    expect(await new ImportCustomers().run(makeReq([[...accounts(4), makeAccount({ id: "x", email: "" })]]).req, step)).toEqual({
      created: 4,
      updated: 0,
      skipped: 1,
      failed: 0,
      pending: 0,
    });
    expect(callsTo(fetchMock, "/api/v2/users/create_or_update")).toHaveLength(4);
    expect(names).toEqual(["load settings", "page 1"]);
  });

  it("also sends users one by one when Zendesk rejects the bulk request", async () => {
    const fetchMock = mockZendesk({ bulk: { status: 422, body: { error: "RecordInvalid" } } });
    expect(await new ImportCustomers().run(makeReq([accounts(2)]).req, makeStep().step)).toMatchObject({ updated: 2 });
    expect(callsTo(fetchMock, "/api/v2/users/create_or_update")).toHaveLength(2);
  });

  it("fails right away on a permanent Zendesk error, naming the refused call", async () => {
    mockZendesk({ bulk: { status: 403, body: { error: "Forbidden" } }, upsert: { status: 403, body: { error: "Forbidden" } } });
    const { step, names } = makeStep();

    await expect(new ImportCustomers().run(makeReq([accounts(2)]).req, step)).rejects.toThrow(
      "Import failed on page 1. Zendesk refused POST /api/v2/users/create_or_update (403 Forbidden). Check that the " +
        "OAuth client belongs to a Zendesk admin and allows read and write access, and that Zendesk IP restrictions are " +
        "off (Swell has no fixed IP addresses). Before failing: created 0, updated 0, skipped 0, failed 0, still " +
        "processing 0.",
    );
    // the step returned instead of throwing, so the workflow didn't retry it
    expect(names).toEqual(["load settings", "page 1"]);
  });

  it("fails right away when a job check is refused", async () => {
    mockZendesk({ job: { status: 401, body: { error: "invalid_token", error_description: "The access token is invalid" } } });
    await expect(new ImportCustomers().run(makeReq([accounts(1)]).req, makeStep().step)).rejects.toThrow(
      /^Import failed on page 1\. Zendesk rejected the OAuth client identifier or secret/,
    );
  });

  it("throws temporary errors so the workflow retries the page", async () => {
    mockZendesk({ bulk: { status: 503, body: {} } });
    await expect(new ImportCustomers().run(makeReq([accounts(1)]).req, makeStep().step)).rejects.toMatchObject({ status: 503 });
  });

  it("finishes an empty store without calling Zendesk", async () => {
    const fetchMock = mockZendesk();
    const { step, names } = makeStep();
    expect(await new ImportCustomers().run(makeReq([]).req, step)).toEqual(emptyStats());
    expect(names).toEqual(["load settings", "page 1"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("doesn't submit a job when every account lacks an email", async () => {
    const fetchMock = mockZendesk();
    const { req } = makeReq([[makeAccount({ email: "" })]]);
    expect(await new ImportCustomers().run(req, makeStep().step)).toMatchObject({ skipped: 1 });
    expect(callsTo(fetchMock, "/api/v2/users/create_or_update_many")).toHaveLength(0);
  });

  it("keeps the client secret out of step output", async () => {
    mockZendesk();
    const { req } = makeReq([accounts(1)]);
    const { step } = makeStep();

    await new ImportCustomers().run(req, step);

    const outputs = await Promise.all((step.do as any).mock.results.map((r: any) => r.value));
    expect(outputs[0]).toEqual({ enabled: true, sync_customers: true, missing: [] });
    const json = JSON.stringify(outputs);
    expect(json).not.toContain(rawSettings.client_secret);
    expect(json).not.toContain("token_1");
  });

  it("retries pages and job checks with backoff", async () => {
    mockZendesk();
    const { step } = makeStep();
    await new ImportCustomers().run(makeReq([accounts(1)]).req, step);
    const calls = (step.do as any).mock.calls;
    expect(calls[1][1]).toEqual({ retries: { limit: 5, delay: "30 seconds", backoff: "exponential" } });
    expect(calls[2][1]).toEqual({ retries: { limit: 5, delay: "30 seconds", backoff: "exponential" } });
  });
});
