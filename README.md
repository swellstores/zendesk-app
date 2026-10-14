# Zendesk integration

A Swell app that keeps Swell customers in [Zendesk](https://www.zendesk.com/) as users with their order history, and opens
Zendesk tickets when a payment fails, an order is canceled or refunded, or a customer requests a return. It connects with a
Zendesk **OAuth client** using the client credentials grant, so no passwords, API tokens or browser sign-in are needed.

## Features

### Connection

Functions get an access token from `POST https://{subdomain}.zendesk.com/oauth/tokens` with
`grant_type: client_credentials`, the client's identifier and secret, scope `read write` and a 30-minute lifetime
(`getAccessToken` in `functions/lib/zendesk.ts`). Zendesk issues these tokens to **confidential** clients only and returns no
refresh token, so a new token is requested once per function run or workflow step. The token acts as the Zendesk user the
OAuth client belongs to.

### Customer sync

`functions/customer-sync.ts` runs on `account.created` and `account.updated` and calls
`POST /api/v2/users/create_or_update`, which matches an existing Zendesk user by `external_id` or email:

| Zendesk user field  | Swell value                                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| `external_id`       | account `id`                                                                        |
| `email`             | account `email`                                                                     |
| `name`              | account `name`, else first and last name, else the email's local part               |
| `phone`             | account phone (else shipping or billing phone) in E.164, using the address country; left out when it can't be formatted |
| `skip_verify_email` | `true`, so Zendesk doesn't send new users a verification email                      |
| `user_fields`       | order context (below), when it's on                                                 |

- `account.updated` syncs only when a profile field changed: `email`, `first_name`, `last_name`, `name`, `phone`, `shipping`
  or `billing`. Changes such as the order count or balance don't call Zendesk.
- Accounts without an email are skipped.
- The app doesn't write anything back to the Swell account, so a sync can't trigger another `account.updated`.
- User tags aren't sent: Zendesk's `tags` field replaces a user's existing tags, which would remove tags added by agents.

### Order context on users

With **Show orders on Zendesk users** on, synced users also get these custom user fields:

| User field key        | Type     | Value                                                         |
| --------------------- | -------- | ------------------------------------------------------------- |
| `swell_order_count`   | integer  | account `order_count`                                         |
| `swell_total_spent`   | decimal  | account `order_value`                                         |
| `swell_last_order`    | text     | latest order, e.g. `#1042 · complete · 120.00 USD · 2026-10-01` |
| `swell_recent_orders` | textarea | the latest **Recent orders to show** orders (default 5), one per line |
| `swell_customer_url`  | text     | `<Swell admin URL>/customers/<account id>`                    |

- **Apps → Zendesk → Actions → Create user fields** (`functions/setup-fields.ts`) creates the fields that don't exist yet
  with `POST /api/v2/user_fields`. It needs an OAuth client that belongs to a Zendesk admin.
- Each sync first reads the existing user fields (`GET /api/v2/user_fields`) and fills only those, so a missing or deleted
  field never makes the sync fail. Recent orders are read from Swell only when a field needs them.
- `functions/order-context.ts` refreshes the fields on `order.submitted`, `order.paid`, `order.delivered`,
  `order.canceled` and `order.refunded`. It needs both **Sync customer accounts** and **Show orders on Zendesk users**, and
  skips orders without a customer account. It also creates the Zendesk user if it doesn't exist yet.

### Tickets from order and return events

`functions/order-tickets.ts` (`order.payment_failed`, `order.canceled`, `order.refunded`) and `functions/return-tickets.ts`
(`return.created`) create a ticket with `POST /api/v2/tickets` when the event's toggle is on:

| Event                  | Setting            | Default | Subject                              |
| ---------------------- | ------------------ | ------- | ------------------------------------ |
| `order.payment_failed` | Payment failed     | on      | Payment failed for order #1042       |
| `order.canceled`       | Order canceled     | off     | Order #1042 was canceled             |
| `order.refunded`       | Order refunded     | off     | Order #1042 was refunded             |
| `return.created`       | Return requested   | on      | Return requested for order #1042     |

- The ticket's requester is the order's customer (name and email; Zendesk finds or creates the user).
- The first comment is an **internal note** (`public: false`) with the customer, order number, total and date (no status,
  so a retry sends the same body), the refund total for refunds,
  the return number, reason and notes for returns, the items (for returns, only the returned ones when the return lists
  their order items) and a link to the order
  in the Swell dashboard. The customer isn't emailed by the app; Zendesk triggers that react to new tickets still apply.
- **Priority**, **Ticket tags** plus a tag for the event (`swell_payment_failed`, `swell_canceled`, `swell_refunded`,
  `swell_return`) and **Group ID** are set from the settings. `external_id` is `swell-<event>-<order or return id>`.
- The ticket link is saved on the order (`zendesk_ticket_payment_failed`, `zendesk_ticket_canceled`,
  `zendesk_ticket_refunded`) or the return (`zendesk_ticket`) and shown on a **Zendesk** tab. A record that already has the
  link gets no second ticket, and the check runs before any Zendesk call.
- Orders without a customer email are skipped, before any Zendesk call.

### Import existing customers

**Apps → Zendesk → Actions → Import existing customers** starts the `functions/import-customers.ts` workflow, which creates
or updates a Zendesk user for every Swell account with an email, with order context when it's on.

- Accounts are read 100 at a time, oldest first (`id` cursor, `functions/lib/import.ts`). Each page is sent as one
  `POST /api/v2/users/create_or_update_many` job, which Zendesk runs in the background.
- If Zendesk refuses or rejects the bulk request (HTTP 403, 400 or 422; some accounts answer 403 even for admins), the
  page's users are sent one by one with
  `POST /api/v2/users/create_or_update`, 3 at a time, and counted as created (HTTP 201) or updated (HTTP 200). Users
  Zendesk rejects (e.g. an invalid email) are logged and counted as failed.
- After each page the workflow checks the job (`GET /api/v2/job_statuses/{id}`) every 10 seconds, up to 12 times, and counts
  each user as created, updated or failed from the job's results. Users of a job that is still running after that are
  counted as **still processing**; users a finished job doesn't report on are counted as failed. Errors for single users are
  logged.
- Page and job-check steps are retried up to 5 times with exponential backoff (starting at 30 s) on Zendesk network errors,
  HTTP 429 and 5xx, and on Swell API errors. Resending a page only repeats the same create-or-update. Other Zendesk errors
  (e.g. 401) aren't retried: the run fails right away with the same explanation as Test connection, which names the refused
  call for 403 and unexpected errors, e.g. `Zendesk refused POST /api/v2/users/create_or_update (403 Forbidden)`.
- The run returns and logs the totals: created, updated, skipped (no email), failed and still processing.
- With **Enabled** or **Sync customer accounts** off, or a connection setting missing, the run doesn't start and fails with
  the reason. Settings are read again at the start of each page: turning the app off during an import lets the current page
  finish, then the run fails with the totals so far.
- Step output, which Swell keeps with the run, holds only flags, counts, record and job IDs and messages, never the client
  secret or an access token.
- The action is hidden while **Sync customer accounts** is off; **Create user fields** is hidden while order context is off.

### Test connection

**Apps → Zendesk → Actions → Test connection** (`functions/test-connection.ts`) gets a token, reads the client's user
(`GET /api/v2/users/me`) and shows its name and role, warns when the user isn't an admin, and, with order context on, lists
the Swell user fields that are missing. It explains rejected credentials, a public (non-confidential) client and an unknown
subdomain (a 404 on the token request only; a 404 from another call is shown as it is), and a refused call (403), naming
the call and the likely causes: a non-admin client user, missing read/write access or Zendesk IP restrictions. It says
"try again later" only for temporary errors (network error, HTTP 429 or 5xx). It works while the app is
off and sends no customer data.

### Retries and duplicates

- User syncs are create-or-update calls, so network errors, HTTP 429 and 5xx are rethrown and Swell retries the event.
- Ticket requests send an `Idempotency-Key` header equal to the ticket's `external_id`. If Swell retries the event after a
  network error or 5xx, Zendesk returns the ticket it already created instead of a new one, as long as the request body is
  the same; the note leaves out values that change quickly, such as the order status. Zendesk keeps idempotency keys
  for 2 hours, and the saved ticket link on the order or return prevents duplicates after that.
- If saving the ticket link fails, the error is logged and the function still succeeds, so Swell doesn't retry it and no
  second ticket is requested.
- Other errors (invalid data, rejected credentials) are logged with `console.error`, with the refused call, and not retried.

### Turning the app off

With **Enabled** off nothing is sent to Zendesk:

- customer sync, order context and ticket functions return before loading any record or getting a token;
- **Create user fields** says the app is off and doesn't change Zendesk;
- **Import existing customers** doesn't start. A running import checks the setting before each page and before each job
  check: the page being sent finishes, then no more Zendesk calls are made and the run fails with the totals so far
  (users of an unfinished job count as still processing).

**Test connection** still works, so you can check the OAuth client before turning the app back on. It reads the client's
user and the user field list, and sends no customer data.

## Settings

All credentials and options are set by the merchant in the app settings (`settings/zendesk.json`) and are never stored in
code. Functions read them with `getSettings` (`functions/lib/zendesk.ts`), which applies the defaults below.

| Setting                 | Type    | Required | Default  | Description                                                                  |
| ----------------------- | ------- | -------- | -------- | ---------------------------------------------------------------------------- |
| `subdomain`             | text    | yes      |          | `acme` for acme.zendesk.com; a full host or URL is accepted too.             |
| `client_id`             | text    | yes      |          | The OAuth client's **Identifier**.                                           |
| `client_secret`         | secret  | yes      |          | The OAuth client's secret (confidential client).                             |
| `enabled`               | toggle  | no       | on       | Turns off everything the app sends to Zendesk.                               |
| `sync_customers`        | toggle  | no       | on       | Create or update Zendesk users from Swell accounts.                          |
| `order_context`         | toggle  | no       | on       | Fill the Swell user fields on synced users.                                  |
| `recent_orders`         | number  | no       | `5`      | Orders in **Swell recent orders** (1–10).                                    |
| `ticket_payment_failed` | toggle  | no       | on       | Ticket when a payment fails.                                                 |
| `ticket_canceled`       | toggle  | no       | off      | Ticket when an order is canceled.                                            |
| `ticket_refunded`       | toggle  | no       | off      | Ticket when an order is refunded.                                            |
| `ticket_return`         | toggle  | no       | on       | Ticket when a return is requested.                                           |
| `ticket_priority`       | select  | no       | `normal` | `low`, `normal`, `high` or `urgent`.                                         |
| `ticket_tags`           | text    | no       | `swell`  | Comma-separated; lowercased, spaces become underscores.                      |
| `ticket_group_id`       | text    | no       |          | Zendesk group ID for new tickets. Empty: Zendesk's default routing.          |

Actions:

| Action                     | Function                        | Shown when                     |
| -------------------------- | ------------------------------- | ------------------------------ |
| Test connection            | `test-connection.ts` (function) | always                         |
| Create user fields         | `setup-fields.ts` (function)    | order context on               |
| Import existing customers  | `import-customers.ts` (workflow) | customer sync on              |

Data stored in Swell (`models/`, shown on a **Zendesk** tab by `content/`):

| Record  | Field                             | Value                    |
| ------- | --------------------------------- | ------------------------ |
| orders  | `zendesk_ticket_payment_failed`   | link to the ticket       |
| orders  | `zendesk_ticket_canceled`         | link to the ticket       |
| orders  | `zendesk_ticket_refunded`         | link to the ticket       |
| returns | `zendesk_ticket`                  | link to the ticket       |

## Setup

1. Install the Swell CLI and log in:

   ```bash
   npm install -g @swell/cli
   swell login
   ```

2. Install dependencies:

   ```bash
   cd /path/to/zendesk
   npm install
   ```

3. Push the app to your store's test environment:

   ```bash
   swell app push
   ```

4. In Zendesk, open **Admin Center → Apps and integrations → APIs → OAuth clients** and add a client. Set **Client kind** to
   **Confidential**, enter any redirect URL (the client credentials grant doesn't use it), save, and copy the **Identifier**
   and the secret. Create it as a Zendesk admin: tokens act as the client's user, and only admins can create user fields.
5. In the Swell dashboard open **Apps → Zendesk**, enter the subdomain, identifier and secret, and save.
6. Run **Actions → Test connection**, then **Actions → Create user fields**.
7. Choose the customer and ticket options and save.
8. Optionally run **Actions → Import existing customers**.
9. To install in the live environment, create a version and install it:

   ```bash
   swell app version minor
   swell app install
   ```

## Limits and known behavior

- **Confidential OAuth client required.** Public clients can't use the client credentials grant.
- **Admin needed for user fields.** Creating user fields needs a client owned by a Zendesk admin.
- **Users are matched by account ID or email.** Zendesk's create-or-update finds an existing user by `external_id` (the
  Swell account ID) or email, so customers who already exist in Zendesk are updated, not duplicated.
- **Bulk import can be refused.** When Zendesk answers 403, 400 or 422 to `create_or_update_many`, the import falls back to
  one call per customer, which is slower and uses more of the rate limit.
- **Zendesk IP restrictions must be off.** IP restrictions apply to API calls too, and Swell functions run without fixed
  outbound IP addresses, so there's nothing to allowlist. With them on, calls fail with 403.
- **Rate limits.** Each customer sync makes 3 Zendesk calls (token, user fields, user) when order context is on, 2 when
  it's off. Each ticket makes 2 (token, ticket). The import makes 3 calls per 100 customers plus 2 per job check. HTTP 429
  is retried by Swell or the workflow.
- **Tickets for past events aren't created.** Only events after the app is installed open tickets; the import syncs users
  only.
- **Order context is refreshed on order events**, not on every account change; the order count and total come from the
  Swell account at that moment.
- **Phone numbers** that can't be formatted to E.164 are left out instead of failing the sync.
- **Idempotency window.** If Swell retries a ticket event more than 2 hours after a failed request that Zendesk had in fact
  completed, and the ticket link couldn't be saved, a second ticket can be created.
- **Customer dashboard link.** `swell_customer_url` and the order link in tickets are built from the store's admin URL.

## Development

### Project layout

```
functions/
  customer-sync.ts     # account.created/updated → Zendesk user
  order-context.ts     # order events → refresh the customer's Swell user fields
  order-tickets.ts     # order.payment_failed/canceled/refunded → ticket
  return-tickets.ts    # return.created → ticket
  test-connection.ts   # settings action: token, client user, user fields
  setup-fields.ts      # settings action: create the Swell user fields
  import-customers.ts  # workflow: import all accounts with bulk jobs
  lib/zendesk.ts       # settings, OAuth token, API client, users, user fields, tickets
  lib/import.ts        # account paging, bulk jobs and job results
models/orders.json     # ticket links on orders ($app.zendesk)
models/returns.json    # ticket link on returns ($app.zendesk)
content/orders.json    # Zendesk tab on orders
content/returns.json   # Zendesk tab on returns
settings/zendesk.json  # merchant settings and settings actions
assets/icon.png        # app icon (official Zendesk mark)
assets/screenshots/    # listing screenshots, referenced by `images` in swell.json
test/unit/             # vitest unit tests (Zendesk API mocked)
test/integration/      # vitest tests against the store using CLI auth
```

### Commands

```bash
npm run typecheck                 # TypeScript check for functions and tests
npm test                          # run all vitest tests
swell app dev                     # run functions locally, triggered by the test environment
swell app push                    # deploy to the test environment
swell inspect functions --app=.   # check deployed functions
swell inspect workflows --app=.   # check the import workflow
swell logs --type function -s customer-sync   # function logs
swell inspect workflow-runs --workflow app.zendesk.import-customers   # import runs
```

Tests run in the Cloudflare Workers runtime via `@cloudflare/vitest-pool-workers` and use your `swell login` session (or
`SWELL_STORE_ID` / `SWELL_SESSION_ID` in CI). Unit tests mock `fetch` by Zendesk endpoint
(`test/helpers/zendesk-fixtures.ts`), so no real Zendesk calls are made.

To try it end to end, use a Zendesk trial or sandbox account, set its OAuth client in the test environment, run
**Create user fields**, create a customer account and an order, and check the Zendesk user. Mark a test order's payment as
failed or create a return to see a ticket. Function logs: `swell logs --type function`.

Workflows don't run under `swell app dev`; the action always starts the pushed version.
