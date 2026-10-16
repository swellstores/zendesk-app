import {
  USER_FIELDS,
  adminUrlOf,
  swellEnv,
  connectionError,
  createContext,
  getSettings,
  getUserFieldKeys,
  missingSettings,
  settingsProblem,
  callZendesk,
} from './lib/zendesk';

export const config: SwellConfig = {
  description: 'Check the Zendesk OAuth client and user fields',
  action: true,
};

export default async function (req: SwellRequest) {
  const settings = getSettings(await req.swell.settings());

  const missing = missingSettings(settings);
  if (missing.length) {
    return { message: `Add the ${missing.join(', ')} and save the settings first.` };
  }
  const problem = settingsProblem(settings);
  if (problem) {
    return { message: problem };
  }

  try {
    const ctx = await createContext(settings, adminUrlOf(req.store, swellEnv(req)));
    const me = (await callZendesk(ctx, 'GET', '/api/v2/users/me'))?.user || {};
    const notes = [`Connected to ${settings.subdomain}.zendesk.com as ${me.name || me.email || 'the OAuth client user'} (${me.role || 'unknown role'}).`];

    if (me.role && me.role !== 'admin') {
      notes.push('The OAuth client belongs to a non-admin user, so Create user fields will not work.');
    }

    if (settings.order_context) {
      const keys = await getUserFieldKeys(ctx);
      const absent = USER_FIELDS.filter((field) => !keys.has(field.key)).map((field) => field.title);
      notes.push(
        absent.length
          ? `Missing user fields: ${absent.join(', ')}. Run Create user fields to add them.`
          : 'All Swell user fields are set up.',
      );
    }
    return { message: notes.join(' ') };
  } catch (err) {
    return { message: connectionError(err, settings) };
  }
}
