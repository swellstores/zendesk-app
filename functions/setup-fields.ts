import {
  USER_FIELDS,
  ZendeskError,
  connectionError,
  createContext,
  createUserFields,
  getSettings,
  missingSettings,
  settingsProblem,
} from './lib/zendesk';

export const config: SwellConfig = {
  description: 'Create the Swell user fields in Zendesk',
  action: true,
};

const titleOf = (key: string) => USER_FIELDS.find((field) => field.key === key)?.title || key;

export default async function (req: SwellRequest) {
  const settings = getSettings(await req.swell.settings());

  // creating fields changes the Zendesk account, so it waits until the app is on
  if (!settings.enabled) {
    return { message: 'The Zendesk app is turned off in its settings. Turn it on to create the user fields.' };
  }

  const missing = missingSettings(settings);
  if (missing.length) {
    return { message: `Add the ${missing.join(', ')} and save the settings first.` };
  }
  const problem = settingsProblem(settings);
  if (problem) {
    return { message: problem };
  }

  try {
    const ctx = await createContext(settings, req.store?.admin_url);
    const { created, existing } = await createUserFields(ctx);
    if (!created.length) {
      return { message: 'All Swell user fields already exist in Zendesk.' };
    }
    const already = existing.length ? ` ${existing.length} already existed.` : '';
    return { message: `Created user fields: ${created.map(titleOf).join(', ')}.${already}` };
  } catch (err) {
    if (err instanceof ZendeskError && err.status === 403) {
      return { message: 'Zendesk refused to create user fields. The OAuth client must belong to a Zendesk admin.' };
    }
    return { message: connectionError(err, settings) };
  }
}
