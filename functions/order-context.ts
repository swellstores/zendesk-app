import { createContext, handleError, loadSettings, syncAccount } from './lib/zendesk';

export const config: SwellConfig = {
  description: "Keep the customer's order context on their Zendesk user",
  model: {
    events: ['order.submitted', 'order.paid', 'order.delivered', 'order.canceled', 'order.refunded'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;

  const settings = await loadSettings(swell);
  // order context lives on the synced Zendesk user, so it needs customer sync too
  if (!settings?.sync_customers || !settings.order_context) {
    return;
  }

  const order = await swell.get('/orders/{id}', { id: data.id, fields: 'id,account_id' });
  if (!order?.account_id) {
    console.log(`Zendesk: order ${data.id} has no customer account, order context not updated`);
    return;
  }

  const account = await swell.get('/accounts/{id}', { id: order.account_id });
  if (!account) {
    console.error(`Zendesk: account ${order.account_id} of order ${data.id} not found`);
    return;
  }

  try {
    const ctx = await createContext(settings, req.store?.admin_url);
    await syncAccount(swell, account, ctx);
  } catch (err) {
    handleError(`order context for order ${data.id}`, err);
  }
}
