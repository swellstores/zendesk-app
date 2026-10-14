import { ZendeskError, callZendesk, userForAccount, zendeskResponse, type SwellClient, type ZendeskContext } from './zendesk';

// accounts loaded per workflow step; also Zendesk's limit for create_or_update_many
export const PAGE_SIZE = 100;

// parallel Swell order lookups for order context
const CONCURRENCY = 10;

// parallel Zendesk calls when users are sent one by one
const UPSERT_CONCURRENCY = 3;

const ACCOUNT_FIELDS = 'id,email,name,first_name,last_name,phone,shipping,billing,order_count,order_value';

export interface ImportStats {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  // submitted to Zendesk, but the job hadn't finished when the workflow stopped checking
  pending: number;
}

export function emptyStats(): ImportStats {
  return { created: 0, updated: 0, skipped: 0, failed: 0, pending: 0 };
}

export function addStats(total: ImportStats, page: Partial<ImportStats>): ImportStats {
  return {
    created: total.created + (page.created || 0),
    updated: total.updated + (page.updated || 0),
    skipped: total.skipped + (page.skipped || 0),
    failed: total.failed + (page.failed || 0),
    pending: total.pending + (page.pending || 0),
  };
}

// next page of accounts after the given id, oldest first
export async function fetchAccounts(swell: Pick<SwellClient, 'get'>, afterId: string | null, limit = PAGE_SIZE): Promise<any[]> {
  const query: any = { sort: 'id asc', limit, fields: ACCOUNT_FIELDS };
  if (afterId) {
    query.where = { id: { $gt: afterId } };
  }
  const page = await swell.get('/accounts', query);
  return page?.results || [];
}

// Zendesk users for a page of accounts; accounts without an email are skipped
export async function buildUsers(
  swell: Pick<SwellClient, 'get'>,
  accounts: any[],
  ctx: ZendeskContext,
  fieldKeys: Set<string> | null,
): Promise<{ users: any[]; skipped: number }> {
  const withEmail = accounts.filter((account) => account?.email);
  const users: any[] = [];
  for (let i = 0; i < withEmail.length; i += CONCURRENCY) {
    const batch = withEmail.slice(i, i + CONCURRENCY);
    users.push(...(await Promise.all(batch.map((account) => userForAccount(swell, account, ctx, fieldKeys)))));
  }
  return { users, skipped: accounts.length - withEmail.length };
}

// queue one Zendesk bulk job that creates or updates the users; returns the job id
export async function submitUsers(ctx: ZendeskContext, users: any[]): Promise<string> {
  const json = await callZendesk(ctx, 'POST', '/api/v2/users/create_or_update_many', { users });
  const id = json?.job_status?.id;
  if (!id) {
    throw new Error('Zendesk did not return a job id for the user import');
  }
  return id;
}

// create or update users one by one, when Zendesk refuses the bulk job; Zendesk answers 201 for a new user, 200 for an update.
// Rejected users (e.g. an invalid email) are counted as failed; 403, network errors, 429 and 5xx are thrown.
export async function upsertEach(ctx: ZendeskContext, users: any[]): Promise<{ created: number; updated: number; failed: number }> {
  const result = { created: 0, updated: 0, failed: 0 };
  for (let i = 0; i < users.length; i += UPSERT_CONCURRENCY) {
    const batch = users.slice(i, i + UPSERT_CONCURRENCY);
    const responses = await Promise.allSettled(
      batch.map((user) =>
        zendeskResponse(ctx.settings, ctx.token, 'POST', '/api/v2/users/create_or_update', { user }),
      ),
    );
    responses.forEach((response, j) => {
      if (response.status === 'fulfilled') {
        response.value.status === 201 ? result.created++ : result.updated++;
        return;
      }
      const err = response.reason;
      if (!(err instanceof ZendeskError) || err.retryable || err.status === 401 || err.status === 403) {
        throw err;
      }
      result.failed++;
      console.error(`Zendesk: import of ${batch[j].email} failed: ${err.detail}`);
    });
  }
  return result;
}

export interface JobResult {
  done: boolean;
  created: number;
  updated: number;
  failed: number;
}

// counts from a Zendesk job status; results without an error are created or updated users
export function countJobResults(job: any): JobResult {
  const done = ['completed', 'failed', 'killed'].includes(job?.status);
  const result: JobResult = { done, created: 0, updated: 0, failed: 0 };
  for (const item of job?.results || []) {
    const status = String(item?.status || '').toLowerCase();
    if (item?.error || status === 'failed') {
      result.failed++;
    } else if (status === 'created') {
      result.created++;
    } else {
      result.updated++;
    }
  }
  return result;
}

export async function getJobResult(ctx: ZendeskContext, jobId: string): Promise<JobResult> {
  const json = await callZendesk(ctx, 'GET', `/api/v2/job_statuses/${encodeURIComponent(jobId)}`);
  const result = countJobResults(json?.job_status);
  if (result.done) {
    for (const error of jobErrors(json?.job_status)) {
      console.error(`Zendesk: import of ${error}`);
    }
  }
  return result;
}

// errors reported for single users in a finished job, for the logs
export function jobErrors(job: any): string[] {
  return (job?.results || [])
    .filter((item: any) => item?.error)
    .map((item: any) => `${item.email || item.external_id || item.index}: ${item.details || item.error}`);
}
