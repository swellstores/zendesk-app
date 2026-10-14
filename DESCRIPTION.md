# Zendesk

Give your support team every customer's Swell orders in Zendesk, and open a ticket when something goes wrong.

## How it works

1. **Customers become Zendesk users.** New and updated customer accounts are created or updated in Zendesk, matched by their Swell account and email.
2. **Orders next to every ticket.** Each Zendesk user shows the number of orders, total spent, last order and recent orders, with a link back to the customer in Swell.
3. **Tickets when something goes wrong.** Failed payments, cancellations, refunds and return requests can each open a ticket for the customer, with the order details in an internal note. Choose the priority, tags and group.
4. **Bring in existing customers.** Import every customer in one click, with real created, updated and failed counts.
5. **Secure connection.** The app connects with a Zendesk OAuth client. No passwords or API tokens are stored.

## Setup

In Zendesk Admin Center → Apps and integrations → APIs → OAuth clients, add a confidential client as an admin. Enter your Zendesk subdomain, the client's identifier and secret in the app settings, run **Test connection**, then **Create user fields**.
