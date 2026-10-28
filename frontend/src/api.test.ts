import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, activateSpeech, api, errorMessage } from './api.ts';
import type { SpeechState } from './api.ts';

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

  it('activates speech within the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ status: 'speaking', answer_id: 'ans-1', voice: 'forrest-synthetic-v1' }),
      ),
    );

    const speech = await activateSpeech('ans-1', 1000);

    expect(speech.status).toBe('speaking');
  });

  it('rejects a lost activation response after the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    await expect(activateSpeech('ans-1', 5)).rejects.toThrow('Speech activation timed out.');
  });

  it('reports a late success that arrives after the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(jsonResponse({ status: 'speaking', answer_id: 'ans-1', voice: 'v' }));
          }, 20);
        }),
      ),
    );

    const late: SpeechState[] = [];
    await expect(activateSpeech('ans-1', 5, (speech) => late.push(speech))).rejects.toThrow(
      'Speech activation timed out.',
    );
    await vi.waitFor(() => {
      expect(late).toHaveLength(1);
    });
    expect(late[0].status).toBe('speaking');
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

  it('scopes a stop to one activation when an id is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'speaking' }));
    vi.stubGlobal('fetch', fetchMock);

    await api.stop('spk-0001');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/stop',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ activation_id: 'spk-0001' }),
      }),
    );
  });

  it('approves an answer under the current selection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ answer_id: 'ans-1', status: 'approved', revoked: false }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.approve('ans-1', ['resume-summary']);

    expect(result.status).toBe('approved');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/approve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          answer_id: 'ans-1',
          approved_source_ids: ['resume-summary'],
        }),
      }),
    );
  });

  it('revokes an answer approval', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ answer_id: 'ans-1', status: 'unapproved', revoked: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.revoke('ans-1');

    expect(result.revoked).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/revoke',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ answer_id: 'ans-1' }),
      }),
    );
  });

  it('syncs the source selection with PUT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ approved_source_ids: ['project-latency'], epoch: 3 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.setSelection(['project-latency']);

    expect(result.epoch).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/selection',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ approved_source_ids: ['project-latency'] }),
      }),
    );
  });

  it('stops unconditionally without an activation id', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ status: 'idle' }));
    vi.stubGlobal('fetch', fetchMock);

    await api.stop();
    await api.stop(null);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/stop',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
