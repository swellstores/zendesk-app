import {
  ZendeskError,
  connectionError,
  createContext,
  getSettings,
  missingSettings,
  settingsProblem,
  orderFieldKeys,
  type ZendeskSettings,
} from './lib/zendesk';
import {
  PAGE_SIZE,
  addStats,
  buildUsers,
  emptyStats,
  fetchAccounts,
  getJobResult,
  submitUsers,
  upsertEach,
  type JobResult,
} from './lib/import';

export const config: SwellConfig = {
  kind: 'workflow',
  description: 'Import existing Swell customers into Zendesk',
  action: true,
};

// how often and how long a page's Zendesk job is checked before it counts as pending
export const JOB_CHECKS = 12;
export const JOB_WAIT = '10 seconds';

const RETRIES = { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' as const } };

// step.do retries every thrown error, so permanent Zendesk errors (403, 422, bad credentials) are returned instead
// and the run fails right away; network errors, 429 and 5xx are thrown and retried
async function permanentError<T>(settings: ZendeskSettings, work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ZendeskError && !err.retryable) {
      console.error(`Zendesk: import failed: ${err.detail}`);
      return { error: connectionError(err, settings) };
    }
    throw err;
  }
}

function failed(result: unknown): string | undefined {
  return result && typeof result === 'object' && 'error' in result ? String((result as any).error) : undefined;
}

interface PageResult {
  count: number;
  last_id: string | null;
  skipped: number;
  submitted: number;
  job_id: string | null;
  // counts when the page was sent one by one instead of as a bulk job
  created?: number;
  updated?: number;
  failed?: number;
  // why the run stopped before the page was sent
  stopped?: string;
}

const totalsText = (t: { created: number; updated: number; skipped: number; failed: number; pending: number }) =>
  `created ${t.created}, updated ${t.updated}, skipped ${t.skipped}, failed ${t.failed}, still processing ${t.pending}`;

export default class ImportCustomers {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep) {
    // step output is stored with the run, so keep only flags here, never the client secret
    const check = await step.do('load settings', async () => {
      const settings = getSettings(await req.swell.settings());
      return {
        enabled: settings.enabled,
        sync_customers: settings.sync_customers,
        missing: missingSettings(settings),
        problem: settingsProblem(settings),
      };
    });

    // throw so the run ends as failed instead of completed
    if (!check.enabled) {
      throw new Error('Import not started: the Zendesk app is turned off in its settings.');
    }
    if (!check.sync_customers) {
      throw new Error('Import not started: Sync customer accounts is off in the app settings.');
    }
    if (check.missing.length) {
      throw new Error(`Import not started: add the ${check.missing.join(', ')} in Apps → Zendesk.`);
    }
    if (check.problem) {
      throw new Error(`Import not started: ${check.problem}`);
    }

    let totals = emptyStats();
    let lastId: string | null = null;

    for (let page = 1; ; page++) {
      const afterId = lastId;
      const result = await step.do(`page ${page}`, RETRIES, async (): Promise<PageResult | { error: string }> => {
        // settings are read in each page so the secret stays out of step output
        const settings = getSettings(await req.swell.settings());
        const empty = { count: 0, last_id: null, skipped: 0, submitted: 0, job_id: null };
        if (!settings.enabled) return { ...empty, stopped: 'the app was turned off in its settings' };
        if (!settings.sync_customers) return { ...empty, stopped: 'Sync customer accounts was turned off' };
        const missing = missingSettings(settings);
        if (missing.length) return { ...empty, stopped: `the ${missing.join(', ')} ${missing.length > 1 ? 'were' : 'was'} removed from the settings` };
        if (settingsProblem(settings)) return { ...empty, stopped: 'the Zendesk subdomain was changed to one that isn\'t valid' };

        const accounts = await fetchAccounts(req.swell, afterId);
        const last_id = accounts[accounts.length - 1]?.id ?? null;
        if (!accounts.length) return empty;

        return permanentError(settings, async () => {
          const ctx = await createContext(settings, req.store?.admin_url);
          const { users, skipped } = await buildUsers(req.swell, accounts, ctx, await orderFieldKeys(ctx));
          const page = { count: accounts.length, last_id, skipped, submitted: users.length };
          if (!users.length) return { ...page, job_id: null };
          // the bulk job creates or updates by external_id/email, so a retried page only repeats the same updates
          try {
            return { ...page, job_id: await submitUsers(ctx, users) };
          } catch (err) {
            // some Zendesk accounts refuse the bulk endpoint even for admins, and a rejected bulk request would lose the
            // whole page; the single endpoint does the same work and reports each user
            if (!(err instanceof ZendeskError && [400, 403, 422].includes(err.status))) throw err;
            console.log(`Zendesk: bulk import refused (${err.detail}), sending ${users.length} users one by one`);
            return { ...page, job_id: null, ...(await upsertEach(ctx, users)) };
          }
        });
      });

      const error = failed(result);
      if (error) {
        throw new Error(`Import failed on page ${page}. ${error} Before failing: ${totalsText(totals)}.`);
      }
      if (!('count' in result)) {
        throw new Error(`Import failed on page ${page}: unexpected step result.`);
      }
      if (result.stopped) {
        throw new Error(`Import stopped: ${result.stopped}. Before stopping: ${totalsText(totals)}.`);
      }

      totals = addStats(totals, { skipped: result.skipped, created: result.created, updated: result.updated, failed: result.failed });
      if (result.job_id) {
        const job = await this.waitForJob(req, step, page, result.job_id, result.submitted);
        if ('error' in job) {
          throw new Error(`Import failed on page ${page}. ${job.error} Before failing: ${totalsText(totals)}.`);
        }
        totals = addStats(totals, job);
        if ('stopped' in job) {
          throw new Error(`Import stopped: ${job.stopped}. Before stopping: ${totalsText(totals)}.`);
        }
      }
      lastId = result.last_id;

      if (result.count < PAGE_SIZE || !lastId) {
        break;
      }
    }

    console.log(`Zendesk: import finished: ${totalsText(totals)}`);
    return totals;
  }

  // check the page's Zendesk job until it finishes; users of a job still running are counted as pending
  async waitForJob(req: SwellWorkflowRequest, step: SwellWorkflowStep, page: number, jobId: string, submitted: number) {
    for (let attempt = 1; attempt <= JOB_CHECKS; attempt++) {
      await step.sleep(`page ${page} wait ${attempt}`, JOB_WAIT);
      const job = await step.do(`page ${page} result ${attempt}`, RETRIES, async () => {
        const settings = getSettings(await req.swell.settings());
        // no more Zendesk calls once the app is turned off; the job's users count as still processing
        if (!settings.enabled) return { stopped: true as const };
        return permanentError(settings, async (): Promise<JobResult> => {
          const ctx = await createContext(settings, req.store?.admin_url);
          return getJobResult(ctx, jobId);
        });
      });
      if ('stopped' in job) {
        console.log(`Zendesk: stopped checking job ${jobId}, the app was turned off in its settings`);
        return { pending: submitted, stopped: 'the app was turned off in its settings' };
      }
      const error = failed(job);
      if (error || !('done' in job)) {
        return { error: error || 'unexpected job result' };
      }
      if (job.done) {
        // users the finished job doesn't report on (e.g. a job that failed as a whole) count as failed
        const missing = Math.max(0, submitted - job.created - job.updated - job.failed);
        return { created: job.created, updated: job.updated, failed: job.failed + missing };
      }
    }
    console.log(`Zendesk: job ${jobId} for page ${page} still running, ${submitted} users counted as still processing`);
    return { pending: submitted };
  }
}
