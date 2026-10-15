Give your support team each customer's Swell orders in Zendesk, and open a ticket when a payment fails, an order is canceled or refunded, or a customer requests a return. Customers become Zendesk users, matched by their Swell account and email.

Connect Zendesk with a confidential OAuth client, choose the events that open a ticket, and set the priority, tags and group of new tickets.

- **Customers in Zendesk.** New customer accounts become Zendesk users with their name, email and phone, and changes to their profile are sent as they happen. Zendesk doesn't send them a verification email.
- **Orders on every user.** Swell orders, Swell total spent, Swell last order and Swell recent orders show on the customer's Zendesk profile, with a link to the customer in Swell. They're updated as orders are placed, paid, fulfilled, canceled and refunded.
- **Tickets when something goes wrong.** Failed payments, cancellations, full refunds and return requests can each open a ticket for the customer. Turn each one on or off.
- **The details agents need.** Each ticket starts with an internal note with the order number, total, date and items, the refund total or the return's reason and notes, and a link to the order in Swell. The app doesn't email the customer.
- **Ticket links on orders.** Links to an order's payment failed, cancellation, refund and return tickets show on its Zendesk tab, and each order or return gets at most one ticket per event.
- **Bring in every customer.** Import your existing customer accounts from the Actions menu. The import runs in the background, and each run shows on the app's Workflows tab.

Setup takes a few minutes. In Zendesk, signed in as an admin, add a confidential OAuth client under Admin Center > Apps and integrations > APIs > OAuth clients, and copy its identifier and secret. Enter your Zendesk subdomain, the identifier and the secret in the app settings, save, and choose Actions > Test connection. Then run Create user fields, and Import existing customers to add the customers you already have.
