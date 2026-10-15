import { parsePhoneNumberWithError, type CountryCode } from 'libphonenumber-js';

export const APP_ID = 'zendesk';

// requested lifetime of OAuth access tokens, in seconds (Zendesk allows 300–172800)
const TOKEN_LIFETIME = 1800;

// the parts of the Swell client the app uses; functions and workflows both provide them
export interface SwellClient {
  get(path: string, data?: any): Promise<any>;
  put(path: string, data?: any): Promise<any>;
  settings(): Promise<any>;
}

// values stored on a standard record under $app.<app id>
export function appValues(values: Record<string, any>, appId = APP_ID): { $app: Record<string, any> } {
  return { $app: { [appId]: values } };
}

export type TicketKind = 'payment_failed' | 'canceled' | 'refunded' | 'return';

export interface ZendeskSettings {
  subdomain: string;
  // what the merchant entered, kept to tell an invalid subdomain from a missing one
  subdomain_input: string;
  client_id: string;
  client_secret: string;
  enabled: boolean;
  sync_customers: boolean;
  order_context: boolean;
  recent_orders: number;
  ticket_payment_failed: boolean;
  ticket_canceled: boolean;
  ticket_refunded: boolean;
  ticket_return: boolean;
  ticket_priority: 'low' | 'normal' | 'high' | 'urgent';
  ticket_tags: string[];
  ticket_group_id: number | null;
}

// Error returned by the Zendesk API (or a network failure when status is 0)
export class ZendeskError extends Error {
  status: number;
  code: string | undefined;
  // the call Zendesk refused, e.g. "POST /api/v2/users/create_or_update_many" (no query string)
  endpoint: string | undefined;

  constructor(status: number, code: string | undefined, message: string, endpoint?: string) {
    super(`Zendesk ${status}${code ? ` ${code}` : ''}: ${message}`);
    this.name = 'ZendeskError';
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
  }

  // message with the refused call, for logs and workflow errors
  get detail(): string {
    return this.endpoint ? `${this.message} (${this.endpoint})` : this.message;
  }

  // network errors, rate limits and server errors are worth retrying
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// "acme", "acme.zendesk.com" or "https://acme.zendesk.com/" → "acme"; '' when it isn't a valid subdomain
export function parseSubdomain(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.zendesk\.com$/, '');
  return /^[a-z0-9][a-z0-9-]*$/.test(host) ? host : '';
}

// comma-separated tags → Zendesk tags (lowercase, spaces become underscores)
export function parseTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [
    ...new Set(
      list
        .map((tag) => String(tag).trim().toLowerCase().replace(/\s+/g, '_'))
        .filter(Boolean),
    ),
  ];
}

// read app settings and apply defaults for values the merchant has not saved yet
export function getSettings(all: any): ZendeskSettings {
  const raw = all?.zendesk || {};
  const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const recent = Number(raw.recent_orders);
  const group = Number(text(String(raw.ticket_group_id ?? '')));

  return {
    subdomain: parseSubdomain(raw.subdomain),
    subdomain_input: text(raw.subdomain),
    client_id: text(raw.client_id),
    client_secret: text(raw.client_secret),
    enabled: flag(raw.enabled, true),
    sync_customers: flag(raw.sync_customers, true),
    order_context: flag(raw.order_context, true),
    recent_orders: Number.isFinite(recent) && recent >= 1 ? Math.min(Math.floor(recent), 10) : 5,
    ticket_payment_failed: flag(raw.ticket_payment_failed, true),
    ticket_canceled: flag(raw.ticket_canceled, false),
    ticket_refunded: flag(raw.ticket_refunded, false),
    ticket_return: flag(raw.ticket_return, true),
    ticket_priority: PRIORITIES.includes(raw.ticket_priority) ? raw.ticket_priority : 'normal',
    ticket_tags: parseTags(raw.ticket_tags ?? 'swell'),
    ticket_group_id: Number.isInteger(group) && group > 0 ? group : null,
  };
}

// the settings the app needs before it can call Zendesk; an entered but invalid subdomain is reported by settingsProblem
export function missingSettings(settings: ZendeskSettings): string[] {
  const missing: string[] = [];
  if (!settings.subdomain && !settings.subdomain_input) missing.push('Zendesk subdomain');
  if (!settings.client_id) missing.push('OAuth client identifier');
  if (!settings.client_secret) missing.push('OAuth client secret');
  return missing;
}

// a setting that is filled in but can't be used, e.g. a custom help-center domain instead of the Zendesk subdomain
export function settingsProblem(settings: ZendeskSettings): string | null {
  if (settings.subdomain_input && !settings.subdomain) {
    return `"${settings.subdomain_input}" isn't a Zendesk subdomain. Enter the first part of your Zendesk address, e.g. acme for acme.zendesk.com; a custom help-center domain can't be used.`;
  }
  return null;
}

// load settings and check the app can call Zendesk
export async function loadSettings(swell: Pick<SwellClient, 'settings'>): Promise<ZendeskSettings | null> {
  const settings = getSettings(await swell.settings());
  if (!settings.enabled) {
    return null;
  }
  const missing = missingSettings(settings);
  if (missing.length) {
    console.error(`Zendesk: missing ${missing.join(', ')} in app settings`);
    return null;
  }
  const problem = settingsProblem(settings);
  if (problem) {
    console.error(`Zendesk: ${problem}`);
    return null;
  }
  return settings;
}

export function zendeskUrl(settings: ZendeskSettings, path = ''): string {
  return `https://${settings.subdomain}.zendesk.com${path}`;
}

// Zendesk's message from the different error body shapes
export function errorMessage(json: any, fallback: string): { code?: string; message: string } {
  if (!json || typeof json !== 'object') {
    return { message: fallback };
  }
  // OAuth: { error, error_description }
  if (typeof json.error === 'string' && json.error_description) {
    return { code: json.error, message: json.error_description };
  }
  // validation: { error, description, details: { field: [{ description }] } }
  if (json.details && typeof json.details === 'object') {
    const details = Object.values(json.details)
      .flat()
      .map((d: any) => d?.description || d?.error)
      .filter(Boolean);
    if (details.length) {
      return { code: typeof json.error === 'string' ? json.error : undefined, message: details.join('; ') };
    }
  }
  // { error: { title, message } }
  if (json.error && typeof json.error === 'object') {
    return { code: json.error.title, message: json.error.message || json.error.title || fallback };
  }
  if (typeof json.error === 'string') {
    return { code: json.error, message: json.description || json.error };
  }
  return { message: json.description || json.message || fallback };
}

// call Zendesk; returns parsed JSON or null for empty responses
export async function zendeskRequest(
  settings: ZendeskSettings,
  token: string | null,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: object,
  extraHeaders: Record<string, string> = {},
): Promise<any> {
  return (await zendeskResponse(settings, token, method, path, body, extraHeaders)).json;
}

// call Zendesk; returns the HTTP status with the parsed JSON (e.g. 201 created vs 200 updated)
export async function zendeskResponse(
  settings: ZendeskSettings,
  token: string | null,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: object,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
  const endpoint = `${method} ${path.split('?')[0]}`;
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(zendeskUrl(settings, path), { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err: any) {
    throw new ZendeskError(0, 'network_error', err?.message || String(err), endpoint);
  }

  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const { code, message } = errorMessage(json, text || res.statusText);
    throw new ZendeskError(res.status, code, message, endpoint);
  }
  return { status: res.status, json };
}

// OAuth access token with the client credentials grant (confidential clients only; no refresh token)
export async function getAccessToken(settings: ZendeskSettings): Promise<string> {
  const json = await zendeskRequest(settings, null, 'POST', '/oauth/tokens', {
    grant_type: 'client_credentials',
    client_id: settings.client_id,
    client_secret: settings.client_secret,
    scope: 'read write',
    expires_in: TOKEN_LIFETIME,
  });
  if (!json?.access_token) {
    throw new ZendeskError(500, undefined, 'no access token in response');
  }
  return json.access_token;
}

// settings plus an access token, created once per function run or workflow step
export interface ZendeskContext {
  settings: ZendeskSettings;
  token: string;
  adminUrl: string;
}

export async function createContext(settings: ZendeskSettings, adminUrl = ''): Promise<ZendeskContext> {
  return { settings, token: await getAccessToken(settings), adminUrl: adminUrl.replace(/\/+$/, '') };
}

export function callZendesk(ctx: ZendeskContext, method: 'GET' | 'POST' | 'PUT', path: string, body?: object, headers?: Record<string, string>) {
  return zendeskRequest(ctx.settings, ctx.token, method, path, body, headers);
}

// Zendesk user fields the app fills in; created by the Create user fields action
export const USER_FIELDS = [
  { key: 'swell_order_count', type: 'integer', title: 'Swell orders', description: 'Number of orders in Swell' },
  { key: 'swell_total_spent', type: 'decimal', title: 'Swell total spent', description: 'Total value of the customer\'s Swell orders' },
  { key: 'swell_last_order', type: 'text', title: 'Swell last order', description: 'Latest Swell order: number, status, total and date' },
  { key: 'swell_recent_orders', type: 'textarea', title: 'Swell recent orders', description: 'Latest Swell orders, one per line' },
  { key: 'swell_customer_url', type: 'text', title: 'Swell customer', description: 'Link to the customer in the Swell dashboard' },
] as const;

export type UserFieldKey = (typeof USER_FIELDS)[number]['key'];

// keys of the user fields that exist in Zendesk
export async function getUserFieldKeys(ctx: ZendeskContext): Promise<Set<string>> {
  const keys = new Set<string>();
  let path: string | null = '/api/v2/user_fields?page[size]=100';
  for (let page = 0; path && page < 20; page++) {
    const json = await callZendesk(ctx, 'GET', path);
    for (const field of json?.user_fields || []) {
      if (field?.key) keys.add(field.key);
    }
    path = json?.meta?.has_more && json?.links?.next ? new URL(json.links.next).pathname + new URL(json.links.next).search : null;
  }
  return keys;
}

// create the app's user fields that don't exist yet; returns the keys created and the ones already there
export async function createUserFields(ctx: ZendeskContext): Promise<{ created: string[]; existing: string[] }> {
  const keys = await getUserFieldKeys(ctx);
  const created: string[] = [];
  const existing: string[] = [];
  for (const field of USER_FIELDS) {
    if (keys.has(field.key)) {
      existing.push(field.key);
      continue;
    }
    await callZendesk(ctx, 'POST', '/api/v2/user_fields', { user_field: { ...field, active: true } });
    created.push(field.key);
  }
  return { created, existing };
}

// Swell account fields that change the Zendesk user
const CUSTOMER_FIELDS = ['email', 'first_name', 'last_name', 'name', 'phone', 'shipping', 'billing'];

// true when the event may change the Zendesk user; account.updated delivers only the changed fields
export function isCustomerChange(eventType: string | undefined, data: any): boolean {
  if (eventType !== 'account.updated') {
    return true;
  }
  return CUSTOMER_FIELDS.some((field) => data?.[field] !== undefined);
}

// E.164 phone, or undefined when it can't be formatted (Zendesk rejects other formats)
export function formatPhone(phone: string | null | undefined, countryCode?: string): string | undefined {
  if (!phone) {
    return undefined;
  }
  try {
    const parsed = parsePhoneNumberWithError(phone, countryCode?.toUpperCase() as CountryCode);
    return parsed?.isValid() ? parsed.number : undefined;
  } catch {
    return undefined;
  }
}

// customer name: account name, first + last name, then the email's local part
export function customerName(account: any): string {
  const parts = [account?.first_name, account?.last_name].filter(Boolean).join(' ');
  return String(account?.name || parts || String(account?.email || '').split('@')[0]).trim();
}

function formatAmount(value: unknown, currency?: string): string {
  const amount = Number(value);
  const text = Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
  return currency ? `${text} ${currency}` : text;
}

function formatDay(value: unknown): string {
  const date = new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

// "#1042 · complete · 120.00 USD · 2026-10-01"
// without the status for ticket notes: a retry must send the same body as the first request (Idempotency-Key)
export function orderLine(order: any, withStatus = true): string {
  return [
    `#${order?.number || order?.id}`,
    withStatus ? order?.status : undefined,
    formatAmount(order?.grand_total, order?.currency),
    formatDay(order?.date_created),
  ]
    .filter(Boolean)
    .join(' · ');
}

// the customer's latest orders, newest first
export async function getRecentOrders(swell: Pick<SwellClient, 'get'>, accountId: string, limit: number): Promise<any[]> {
  const page = await swell.get('/orders', {
    where: { account_id: accountId },
    sort: 'date_created desc',
    limit,
    fields: 'id,number,status,grand_total,currency,date_created',
  });
  return page?.results || [];
}

export function customerUrl(adminUrl: string, accountId: string): string | undefined {
  return adminUrl && accountId ? `${adminUrl}/customers/${accountId}` : undefined;
}

// order context user fields, limited to the fields that exist in Zendesk
export function orderFields(account: any, orders: any[], adminUrl: string, fieldKeys: Set<string>): Record<string, any> {
  const values: Record<UserFieldKey, any> = {
    swell_order_count: Number(account?.order_count) || 0,
    swell_total_spent: Number(Number(account?.order_value || 0).toFixed(2)),
    swell_last_order: orders.length ? orderLine(orders[0]) : '',
    swell_recent_orders: orders.map((order) => orderLine(order)).join('\n'),
    // without the admin URL (workflow runs don't get one) the link is left out, so an existing link isn't cleared
    swell_customer_url: customerUrl(adminUrl, account?.id),
  };
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => fieldKeys.has(key) && value !== undefined));
}

// Zendesk user for a Swell account; matched by external_id (the account id) or email
export function buildUser(account: any, userFields?: Record<string, any>): any {
  const country = account?.shipping?.country || account?.billing?.country;
  const phone = formatPhone(account?.phone || account?.shipping?.phone || account?.billing?.phone, country);
  const user: any = {
    external_id: String(account.id),
    email: account.email,
    name: customerName(account),
    skip_verify_email: true,
  };
  if (phone) user.phone = phone;
  if (userFields && Object.keys(userFields).length) user.user_fields = userFields;
  return user;
}

// Zendesk user with order context when it's on; Swell orders are read only when the fields exist
export async function userForAccount(
  swell: Pick<SwellClient, 'get'>,
  account: any,
  ctx: ZendeskContext,
  fieldKeys: Set<string> | null,
): Promise<any> {
  if (!ctx.settings.order_context || !fieldKeys?.size) {
    return buildUser(account);
  }
  const orders =
    fieldKeys.has('swell_last_order') || fieldKeys.has('swell_recent_orders')
      ? await getRecentOrders(swell, account.id, ctx.settings.recent_orders)
      : [];
  return buildUser(account, orderFields(account, orders, ctx.adminUrl, fieldKeys));
}

// field keys to fill in, or null when order context is off
export async function orderFieldKeys(ctx: ZendeskContext): Promise<Set<string> | null> {
  return ctx.settings.order_context ? getUserFieldKeys(ctx) : null;
}

// create or update one Zendesk user; returns the Zendesk user id
export async function upsertUser(ctx: ZendeskContext, user: any): Promise<number | undefined> {
  const json = await callZendesk(ctx, 'POST', '/api/v2/users/create_or_update', { user });
  return json?.user?.id;
}

// sync a Swell account to its Zendesk user; skipped without an email
export async function syncAccount(swell: Pick<SwellClient, 'get'>, account: any, ctx: ZendeskContext): Promise<boolean> {
  if (!account?.email) {
    console.log(`Zendesk: account ${account?.id} has no email, not synced`);
    return false;
  }
  const fieldKeys = await orderFieldKeys(ctx);
  const user = await userForAccount(swell, account, ctx, fieldKeys);
  const id = await upsertUser(ctx, user);
  console.log(`Zendesk: synced ${account.email} to user ${id}`);
  return true;
}

// --- tickets ---

export const TICKET_EVENTS: Record<string, { kind: TicketKind; setting: keyof ZendeskSettings }> = {
  'order.payment_failed': { kind: 'payment_failed', setting: 'ticket_payment_failed' },
  'order.canceled': { kind: 'canceled', setting: 'ticket_canceled' },
  'order.refunded': { kind: 'refunded', setting: 'ticket_refunded' },
  'return.created': { kind: 'return', setting: 'ticket_return' },
};

// order field with the latest return's ticket, shown on the order's Zendesk tab
export const RETURN_TICKET_ON_ORDER = 'zendesk_ticket_return';

// field on the Swell record that keeps the ticket link
export function ticketField(kind: TicketKind): string {
  return kind === 'return' ? 'zendesk_ticket' : `zendesk_ticket_${kind}`;
}

export function ticketUrl(settings: ZendeskSettings, id: number | string): string {
  return zendeskUrl(settings, `/agent/tickets/${id}`);
}

function itemLines(order: any, only?: Map<string, number>): string[] {
  const lines: string[] = [];
  for (const item of order?.items || []) {
    if (only && !only.has(item.id)) continue;
    const quantity = only ? only.get(item.id) : item.quantity;
    const name = item.product?.name || item.product_name || item.product_id;
    lines.push(`- ${quantity ?? 1} × ${name}${item.variant?.name ? ` (${item.variant.name})` : ''}`);
  }
  return lines;
}

// ticket subject and internal note for an order or return event; no timestamps, so a retry sends the same body
export function ticketText(kind: TicketKind, order: any, adminUrl: string, ret?: any): { subject: string; body: string } {
  const number = `#${order?.number || order?.id}`;
  const subjects: Record<TicketKind, string> = {
    payment_failed: `Payment failed for order ${number}`,
    canceled: `Order ${number} was canceled`,
    refunded: `Order ${number} was refunded`,
    return: `Return requested for order ${number}`,
  };
  const lines = [
    subjects[kind] + '.',
    '',
    `Customer: ${customerName(order?.account)} <${order?.account?.email}>`,
    `Order: ${orderLine(order, false)}`,
  ];
  if (kind === 'refunded' && order?.refund_total !== undefined) {
    lines.push(`Refunded: ${formatAmount(order.refund_total, order.currency)}`);
  }
  if (kind === 'return' && ret) {
    if (ret.number) lines.push(`Return: #${ret.number}`);
    if (ret.reason_code) lines.push(`Reason: ${ret.reason_code}`);
    if (ret.notes) lines.push(`Notes: ${ret.notes}`);
  }
  const returned =
    kind === 'return' && Array.isArray(ret?.items)
      ? new Map<string, number>(
          ret.items.filter((i: any) => i?.order_item_id).map((i: any) => [String(i.order_item_id), Number(i.quantity) || 1]),
        )
      : undefined;
  const items = itemLines(order, returned?.size ? returned : undefined);
  if (items.length) {
    lines.push('', kind === 'return' && returned?.size ? 'Returned items:' : 'Items:', ...items);
  }
  if (adminUrl && order?.id) {
    lines.push('', `Swell order: ${adminUrl}/orders/${order.id}`);
  }
  return { subject: subjects[kind], body: lines.join('\n') };
}

export function buildTicket(kind: TicketKind, order: any, ctx: ZendeskContext, ret?: any): any {
  const { settings } = ctx;
  const { subject, body } = ticketText(kind, order, ctx.adminUrl, ret);
  const ticket: any = {
    subject,
    // internal note: the customer isn't emailed about the ticket
    comment: { body, public: false },
    requester: { name: customerName(order.account), email: order.account.email },
    priority: settings.ticket_priority,
    tags: [...new Set([...settings.ticket_tags, `swell_${kind}`])],
    external_id: `swell-${kind}-${ret?.id || order.id}`,
  };
  if (settings.ticket_group_id) ticket.group_id = settings.ticket_group_id;
  return ticket;
}

// link of the ticket already created for this record and event, if any
export function existingTicket(record: any, kind: TicketKind, appId?: string | null): string | undefined {
  return record?.$app?.[appId || APP_ID]?.[ticketField(kind)] || undefined;
}

export interface TicketResult {
  status: 'created' | 'skipped';
  reason?: string;
  url?: string;
}

// create the ticket once per record and event; the Idempotency-Key makes a retry within 2 hours return the same ticket
export async function createTicket(
  swell: SwellClient,
  kind: TicketKind,
  order: any,
  ctx: ZendeskContext,
  options: { ret?: any; appId?: string } = {},
): Promise<TicketResult> {
  const record = options.ret || order;
  const collection = options.ret ? 'returns' : 'orders';
  const field = ticketField(kind);

  if (existingTicket(record, kind, options.appId)) {
    return { status: 'skipped', reason: 'ticket already created' };
  }
  if (!order?.account?.email) {
    return { status: 'skipped', reason: 'no customer email' };
  }

  const ticket = buildTicket(kind, order, ctx, options.ret);
  const json = await callZendesk(ctx, 'POST', '/api/v2/tickets', { ticket }, { 'Idempotency-Key': ticket.external_id });
  const url = ticketUrl(ctx.settings, json?.ticket?.id);

  // a failed save is logged, not thrown: the ticket exists, and a retry would only return it again
  try {
    await swell.put(`/${collection}/${record.id}`, appValues({ [field]: url }, options.appId));
  } catch (err) {
    console.error(`Zendesk: ticket ${url} not saved on ${collection} ${record.id}:`, err instanceof Error ? err.message : err);
  }
  // returns have no page of their own in the dashboard, so the link is also shown on the order's Zendesk tab
  if (options.ret && order?.id) {
    try {
      await swell.put(`/orders/${order.id}`, appValues({ [RETURN_TICKET_ON_ORDER]: url }, options.appId));
    } catch (err) {
      console.error(`Zendesk: ticket ${url} not saved on orders ${order.id}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`Zendesk: created ticket ${url} (${kind}) for ${collection} ${record.id}`);
  return { status: 'created', url };
}

// friendly message for Zendesk errors; "try again" only for temporary ones
export function connectionError(err: unknown, settings: ZendeskSettings): string {
  if (err instanceof ZendeskError) {
    if (err.status === 0 && /dns|resolve|not found|ENOTFOUND/i.test(err.message)) {
      return `${settings.subdomain}.zendesk.com could not be reached. Check the Zendesk subdomain.`;
    }
    if (err.code === 'invalid_client' || err.status === 401) {
      return (
        'Zendesk rejected the OAuth client identifier or secret. Check them in Admin Center → Apps and integrations → ' +
        'APIs → OAuth clients, and that the client is confidential.'
      );
    }
    if (err.code === 'unauthorized_client' || err.code === 'unsupported_grant_type') {
      return 'Zendesk does not allow this client to get tokens with its secret. Set the OAuth client type to Confidential.';
    }
    if (err.status === 403) {
      return (
        `Zendesk refused ${err.endpoint || 'the request'} (403 Forbidden). Check that the OAuth client belongs to a Zendesk ` +
        'admin and allows read and write access, and that Zendesk IP restrictions are off (Swell has no fixed IP addresses).'
      );
    }
    if (err.code === 'invalid_scope') {
      return 'Zendesk did not grant the read and write scopes. Check the OAuth client in Admin Center.';
    }
    // only the token request tells a wrong subdomain apart; a 404 elsewhere is reported as it is
    if (err.status === 404 && err.endpoint === 'POST /oauth/tokens') {
      return `No Zendesk account found at ${settings.subdomain}.zendesk.com. Check the Zendesk subdomain.`;
    }
    if (err.retryable) {
      return `Zendesk request failed, try again later: ${err.detail}`;
    }
    return `Zendesk request failed: ${err.detail}`;
  }
  return `Zendesk request failed: ${err instanceof Error ? err.message : err}`;
}

// rethrow errors Swell should retry, log the rest
export function handleError(label: string, err: unknown): void {
  if (err instanceof ZendeskError && err.retryable) {
    throw err;
  }
  console.error(`Zendesk: ${label} failed:`, err instanceof ZendeskError ? err.detail : err instanceof Error ? err.message : err);
}
