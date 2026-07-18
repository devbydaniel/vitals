import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchDocuments, OURA_ENDPOINTS } from './client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const sleepEndpoint = OURA_ENDPOINTS.find((e) => e.path === 'daily_sleep');
if (!sleepEndpoint)
  throw new Error('daily_sleep endpoint missing from registry');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDocuments', () => {
  it('follows next_token pagination and aggregates all pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'a', day: '2026-07-16' }],
          next_token: 't1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'b', day: '2026-07-17' }],
          next_token: null,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const docs = await fetchDocuments(
      'tok',
      sleepEndpoint,
      '2026-07-10',
      '2026-07-17',
    );

    expect(docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1][0] as URL;
    expect(secondUrl.searchParams.get('next_token')).toBe('t1');
    expect(secondUrl.searchParams.get('start_date')).toBe('2026-07-10');
  });

  it('sends the bearer token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [], next_token: null }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchDocuments(
      'secret-token',
      sleepEndpoint,
      '2026-07-10',
      '2026-07-17',
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret-token',
    );
  });

  it('fails fast on non-retryable errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: 'bad request' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchDocuments('tok', sleepEndpoint, 'x', 'y'),
    ).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and succeeds', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ detail: 'rate limited' }, 429))
        .mockResolvedValueOnce(
          jsonResponse({ data: [{ id: 'a' }], next_token: null }),
        );
      vi.stubGlobal('fetch', fetchMock);

      const promise = fetchDocuments('tok', sleepEndpoint, 'x', 'y');
      await vi.runAllTimersAsync();
      const docs = await promise;

      expect(docs).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
