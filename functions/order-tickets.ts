import { TICKET_EVENTS, createContext, createTicket, existingTicket, handleError, loadSettings } from './lib/zendesk';

export const config: SwellConfig = {
  description: 'Create Zendesk tickets for order events',
  model: {
    events: ['order.payment_failed', 'order.canceled', 'order.refunded'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const event = TICKET_EVENTS[data.$event?.type];
  if (!event) {
    return;
  }

  const settings = await loadSettings(swell);
  if (!settings?.[event.setting]) {
    return;
  }

  const order = await swell.get('/orders/{id}', {
    id: data.id,
    expand: ['account', 'items.product', 'items.variant'],
  });
  if (!order) {
    console.error(`Zendesk: order ${data.id} not found`);
    return;
  }

  // checked before getting a token: an event delivered again needs no Zendesk call
  if (existingTicket(order, event.kind, req.appId)) {
    console.log(`Zendesk: ${event.kind} ticket for order ${data.id} already created`);
    return;
  }
  if (!order.account?.email) {
    console.log(`Zendesk: ${event.kind} ticket for order ${data.id} skipped, no customer email`);
    return;
  }

  try {
    const ctx = await createContext(settings, req.store?.admin_url);
    const result = await createTicket(swell, event.kind, order, ctx, { appId: req.appId || undefined });
    if (result.status === 'skipped') {
      console.log(`Zendesk: ${event.kind} ticket for order ${data.id} skipped, ${result.reason}`);
    }
  } catch (err) {
    handleError(`${event.kind} ticket for order ${data.id}`, err);
  }
}
