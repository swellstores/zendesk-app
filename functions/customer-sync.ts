import { adminUrlOf, swellEnv, createContext, handleError, isCustomerChange, loadSettings, syncAccount } from './lib/zendesk';

export const config: SwellConfig = {
  description: 'Create or update Zendesk users from Swell accounts',
  model: {
    events: ['account.created', 'account.updated'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const eventType = data.$event?.type;

  const settings = await loadSettings(swell);
  if (!settings?.sync_customers) {
    return;
  }

  // changes such as the order count or balance don't change the Zendesk user's profile
  if (!isCustomerChange(eventType, data)) {
    return;
  }

  const account = await swell.get('/accounts/{id}', { id: data.id });
  if (!account) {
    console.error(`Zendesk: account ${data.id} not found`);
    return;
  }

  try {
    const ctx = await createContext(settings, adminUrlOf(req.store, swellEnv(req)));
    await syncAccount(swell, account, ctx);
  } catch (err) {
    handleError(`sync of account ${data.id}`, err);
  }
}
