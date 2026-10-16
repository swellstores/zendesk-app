import { adminUrlOf, createContext, createTicket, existingTicket, handleError, listReturnTickets, loadSettings } from './lib/zendesk';

export const config: SwellConfig = {
  description: 'Create Zendesk tickets for return requests',
  model: {
    events: ['return.created', 'return.updated'],
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

  // checked before getting a token: an event delivered again needs no Zendesk call. The return's ticket, e.g. one
  // created by an earlier version or after a lost write, is listed on the order (only Swell is called, and nothing is
  // written when the order already lists it)
  if (existingTicket(ret, 'return', req.appId)) {
    if (data.$event?.type === 'return.created') {
      console.log(`Zendesk: ticket for return ${data.id} already created`);
    }
    await listReturnTickets(swell, ret.order_id, req.appId);
    return;
  }
  // an updated return without a ticket gets none: tickets are created for new return requests only
  if (data.$event?.type !== 'return.created') {
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

  if (!order.account?.email) {
    console.log(`Zendesk: ticket for return ${data.id} skipped, no customer email`);
    return;
  }

  try {
    const ctx = await createContext(settings, adminUrlOf(req.store));
    const result = await createTicket(swell, 'return', order, ctx, { ret, appId: req.appId || undefined });
    if (result.status === 'skipped') {
      console.log(`Zendesk: return ticket for return ${data.id} skipped, ${result.reason}`);
    }
  } catch (err) {
    handleError(`return ticket for return ${data.id}`, err);
  }
}
