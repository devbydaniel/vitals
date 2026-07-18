export const OURA_BASE_URL = 'https://api.ouraring.com';
export const OURA_AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
export const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
// Scope names for apps registered in the new developer portal
// (developer.ouraring.com); the pre-2025 names (email, daily, spo2Daily, ...)
// are invalid for these apps.
export const OURA_SCOPES =
  'extapi:email extapi:personal extapi:daily extapi:heartrate extapi:tag ' +
  'extapi:workout extapi:session extapi:spo2 extapi:ring_configuration ' +
  'extapi:stress extapi:heart_health';

export interface OuraEndpoint {
  /** Path segment under /v2/usercollection/ */
  path: string;
  /** Target table in Postgres */
  table: string;
  /** Which query params the endpoint takes */
  params: 'date' | 'datetime';
}

export const OURA_ENDPOINTS: OuraEndpoint[] = [
  { path: 'daily_sleep', table: 'oura_daily_sleep', params: 'date' },
  { path: 'daily_readiness', table: 'oura_daily_readiness', params: 'date' },
  { path: 'daily_activity', table: 'oura_daily_activity', params: 'date' },
  { path: 'daily_stress', table: 'oura_daily_stress', params: 'date' },
  { path: 'daily_resilience', table: 'oura_daily_resilience', params: 'date' },
  { path: 'daily_spo2', table: 'oura_daily_spo2', params: 'date' },
  {
    path: 'daily_cardiovascular_age',
    table: 'oura_daily_cardiovascular_age',
    params: 'date',
  },
  { path: 'vO2_max', table: 'oura_vo2_max', params: 'date' },
  { path: 'sleep', table: 'oura_sleep', params: 'date' },
  { path: 'sleep_time', table: 'oura_sleep_time', params: 'date' },
  { path: 'workout', table: 'oura_workout', params: 'date' },
  { path: 'session', table: 'oura_session', params: 'date' },
  { path: 'enhanced_tag', table: 'oura_enhanced_tag', params: 'date' },
  { path: 'rest_mode_period', table: 'oura_rest_mode_period', params: 'date' },
];

export const OURA_HEARTRATE_PATH = 'heartrate';

export interface OuraDocument {
  id: string;
  day?: string;
  [key: string]: unknown;
}

interface OuraPage<T> {
  data: T[];
  next_token: string | null;
}

const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: URL,
  accessToken: string,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) return response;
    const body = await response.text();
    lastError = new Error(
      `Oura API ${url.pathname} failed (${String(response.status)}): ${body}`,
    );
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) throw lastError;
  }
  throw lastError ?? new Error('unreachable');
}

async function fetchAllPages<T>(
  accessToken: string,
  path: string,
  query: Record<string, string>,
): Promise<T[]> {
  const items: T[] = [];
  let nextToken: string | null = null;
  do {
    const url = new URL(`/v2/usercollection/${path}`, OURA_BASE_URL);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    if (nextToken !== null) url.searchParams.set('next_token', nextToken);
    const response = await fetchWithRetry(url, accessToken);
    const page = (await response.json()) as OuraPage<T>;
    items.push(...page.data);
    nextToken = page.next_token;
  } while (nextToken !== null);
  return items;
}

/** Fetch all documents of a date-windowed endpoint (inclusive dates, YYYY-MM-DD). */
export async function fetchDocuments(
  accessToken: string,
  endpoint: OuraEndpoint,
  startDate: string,
  endDate: string,
): Promise<OuraDocument[]> {
  return fetchAllPages<OuraDocument>(accessToken, endpoint.path, {
    start_date: startDate,
    end_date: endDate,
  });
}

export interface OuraHeartrateSample {
  bpm: number;
  source: string;
  timestamp: string;
}

/** Fetch heartrate samples; takes ISO datetimes instead of dates. */
export async function fetchHeartrate(
  accessToken: string,
  startDatetime: string,
  endDatetime: string,
): Promise<OuraHeartrateSample[]> {
  return fetchAllPages<OuraHeartrateSample>(accessToken, OURA_HEARTRATE_PATH, {
    start_datetime: startDatetime,
    end_datetime: endDatetime,
  });
}
