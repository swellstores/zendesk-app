import { swellEnv } from './lib/zendesk';

export const config: SwellConfig = {
  description: 'Start the customer import in the current environment',
  action: true,
};

// Workflows get no request headers, so this action reads the environment (Swell-Env) and passes it to the import:
// customer links in the test environment then point to /admin/test like the ones event functions send
export default async function (req: SwellRequest) {
  const run = await req.swell.workflows.create('import-customers', { env: swellEnv(req) });
  console.log(`Zendesk: started customer import ${run?.id}${swellEnv(req) ? ' (test environment)' : ''}`);
  return { message: 'Import started. Follow it in the Workflows tab of the app.' };
}
