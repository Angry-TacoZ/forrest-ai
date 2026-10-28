import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, errorMessage } from './api.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('transcribes the requested scenario', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        question: 'Tell me about your work.',
        scenario: 'supported',
        engine: 'mock-transcribe-v1',
        duration_ms: 1800,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.transcribe('supported');

    expect(result.question).toBe('Tell me about your work.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/transcribe',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws ApiError carrying the backend detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'cannot speak this' }, 422)),
    );

    await expect(api.speak('ans-blocked')).rejects.toMatchObject({
      status: 422,
      message: 'cannot speak this',
    });
  });

  it('falls back to the status text without a JSON error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 })),
    );

    const error = await api.health().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it('formats unknown failures for display', () => {
    expect(errorMessage(new ApiError(500, 'boom'))).toBe('Backend error 500: boom');
    expect(errorMessage(new Error('plain'))).toBe('plain');
    expect(errorMessage('weird')).toBe('Unexpected error');
  });

  it('sends the approval selection with answer requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: 'grounded', answer: 'a', claims: [], reason: '', answer_id: 'ans-1' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.answer('Q?', [], ['resume-summary']);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/answer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          question: 'Q?',
          evidence: [],
          approved_source_ids: ['resume-summary'],
        }),
      }),
    );
  });
});
