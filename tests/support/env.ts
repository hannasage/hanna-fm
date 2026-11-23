/**
 * Values the global setup puts in the environment for the test workers.
 * They live in memory only. No test writes them to disk or prints them.
 */
export type TestEnv = {
  apiUrl: string;
  dbUrl: string;
  anonKey: string;
  publishableKey: string | undefined;
  serviceRoleKey: string;
  healthySiteUrl: string;
  refusedSiteUrl: string;
  hangingSiteUrl: string;
};

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Is global setup running?`);
  }
  return value;
}

export function testEnv(): TestEnv {
  return {
    apiUrl: need("TEST_API_URL"),
    dbUrl: need("TEST_DB_URL"),
    anonKey: need("TEST_ANON_KEY"),
    publishableKey: process.env.TEST_PUBLISHABLE_KEY || undefined,
    serviceRoleKey: need("TEST_SERVICE_ROLE_KEY"),
    healthySiteUrl: need("TEST_SITE_HEALTHY_URL"),
    refusedSiteUrl: need("TEST_SITE_REFUSED_URL"),
    hangingSiteUrl: need("TEST_SITE_HANGING_URL"),
  };
}
