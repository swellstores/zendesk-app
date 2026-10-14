import { createContext, createTicket, existingTicket, handleError, loadSettings } from './lib/zendesk';

export const config: SwellConfig = {
  description: 'Create Zendesk tickets for return requests',
  model: {
    events: ['return.created'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;

  const settings = await loadSettings(swell);
  if (!settings?.ticket_return) {
    return;
  }

  const ret = await swell.get('/returns/{id}', { id: data.id });
  if (!ret?.order_id) {
    console.error(`Zendesk: return ${data.id} not found or has no order`);
    return;
  }

  const order = await swell.get('/orders/{id}', {
    id: ret.order_id,
    expand: ['account', 'items.product', 'items.variant'],
  });
  if (!order) {
    console.error(`Zendesk: order ${ret.order_id} of return ${data.id} not found`);
    return;
  }

  // checked before getting a token: an event delivered again needs no Zendesk call
  if (existingTicket(ret, 'return', req.appId)) {
    console.log(`Zendesk: ticket for return ${data.id} already created`);
    return;
  }

  try {
    const ctx = await createContext(settings, req.store?.admin_url);
    const result = await createTicket(swell, 'return', order, ctx, { ret, appId: req.appId || undefined });
    if (result.status === 'skipped') {
      console.log(`Zendesk: return ticket for return ${data.id} skipped, ${result.reason}`);
    }
  } catch (err) {
    handleError(`return ticket for return ${data.id}`, err);
  }
}
