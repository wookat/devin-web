// edition.ts — deployment edition flag + feature-gate table.
//
// One env knob, DEVIN_WEB_EDITION, selects the capability set the binary
// serves; feature code NEVER branches on the edition name — it asks
// featureEnabled("x"). Future editions (team/school/enterprise) change
// behavior by editing THIS table, not by sprinkling conditionals.

export type Edition = "local" | "team" | "school" | "enterprise";

const KNOWN: readonly string[] = ["local", "team", "school", "enterprise"];
export const edition: Edition = KNOWN.includes(process.env.DEVIN_WEB_EDITION ?? "")
  ? process.env.DEVIN_WEB_EDITION as Edition
  : "local";

/** Gateable capabilities. Anything edition-shaped hangs off this list —
 * auth model, quotas, audit, per-user scoping live behind these flags. */
export type Feature =
  | "multiUser"       // per-user sessions/accounts/isolation
  | "sso"             // enterprise identity providers
  | "roster"          // school class/roster groups
  | "quotas"          // per-user usage limits
  | "audit"           // audit log + compliance exports
  | "adminKey"        // DEVIN_WEB_ADMIN_KEY gate on /api/admin/*
  | "security" | "wiki" | "automations" | "persona" | "share"
  | "dashboardMcp";

const EVERYTHING = {
  adminKey: true, security: true, wiki: true, automations: true, persona: true, share: true,
  dashboardMcp: true,
} satisfies Partial<Record<Feature, boolean>>;

const FEATURES: Record<Edition, Partial<Record<Feature, boolean>>> = {
  local: EVERYTHING,
  team: { ...EVERYTHING, multiUser: true },
  school: { ...EVERYTHING, multiUser: true, roster: true, quotas: true },
  enterprise: { ...EVERYTHING, multiUser: true, sso: true, quotas: true, audit: true },
};

export function featureEnabled(f: Feature): boolean {
  return FEATURES[edition][f] === true;
}
