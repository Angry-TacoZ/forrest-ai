import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App.tsx';

const SOURCES = [
  {
    id: 'resume-summary',
    title: 'Resume summary (fictional)',
    kind: 'resume',
    summary: '4 years of Python backend work.',
    approved_default: true,
  },
  {
    id: 'project-latency',
    title: 'Project story (fictional)',
    kind: 'project',
    summary: 'Cut checkout latency.',
    approved_default: true,
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubApi() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/health') {
      return jsonResponse({ status: 'ok', service: 'forrest-ai-backend', version: '0.1.0' });
    }
    if (url === '/api/sources') {
      return jsonResponse({ sources: SOURCES });
    }
    if (url === '/api/transcribe') {
      return jsonResponse({
        question: 'Tell me about your backend experience.',
        scenario: 'supported',
        engine: 'mock-transcribe-v1',
        duration_ms: 1800,
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('interview workspace', () => {
  it('loads the knowledge library and shows backend state', async () => {
    stubApi();
    render(<App />);

    expect(await screen.findByText('Resume summary (fictional)')).toBeInTheDocument();
    expect(await screen.findByText('Backend: online')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Knowledge library' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Interview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review and speak' })).toBeInTheDocument();
  });

  it('captures a question into the transcript area', async () => {
    stubApi();
    render(<App />);

    const capture = await screen.findByRole('button', { name: 'Capture question' });
    fireEvent.click(capture);

    expect(await screen.findByText('Tell me about your backend experience.')).toBeInTheDocument();
    expect(await screen.findByText('State: Question captured')).toBeInTheDocument();
  });

  it('keeps activation disabled before an approved answer exists', async () => {
    stubApi();
    render(<App />);

    const activate = await screen.findByRole('button', { name: 'Activate Forrest' });
    expect(activate).toBeDisabled();
  });
});

const TRANSCRIPT_QUESTION = 'Tell me about your backend experience.';

const EVIDENCE = [
  {
    source_id: 'resume-summary',
    source_title: 'Resume summary (fictional)',
    excerpt: 'Four years of Python backend experience.',
    relevance: 0.75,
  },
];

const GROUNDED_ANSWER = {
  status: 'grounded',
  answer: 'Based on your approved materials: four years of Python backend experience.',
  claims: [
    {
      text: 'Four years of Python backend experience.',
      source_ids: ['resume-summary'],
    },
  ],
  reason: '',
  answer_id: 'ans-1',
};

const IDLE_SPEECH = { status: 'idle', answer_id: null, voice: 'forrest-synthetic-v1' };

interface FullApiOptions {
  retrieveGate?: Promise<Response>;
  answerGate?: Promise<Response>;
  speakGate?: Promise<Response>;
  speakResponses?: Promise<Response>[];
  stop?: () => Promise<Response>;
}

function stubFullApi(options: FullApiOptions = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/health') {
      return jsonResponse({ status: 'ok', service: 'forrest-ai-backend', version: '0.1.0' });
    }
    if (url === '/api/sources') {
      return jsonResponse({ sources: SOURCES });
    }
    if (url === '/api/transcribe') {
      return jsonResponse({
        question: TRANSCRIPT_QUESTION,
        scenario: 'supported',
        engine: 'mock-transcribe-v1',
        duration_ms: 1800,
      });
    }
    if (url === '/api/retrieve') {
      if (options.retrieveGate) {
        return options.retrieveGate;
      }
      return jsonResponse({ evidence: EVIDENCE, searched_sources: 2 });
    }
    if (url === '/api/answer') {
      if (options.answerGate) {
        return options.answerGate;
      }
      return jsonResponse(GROUNDED_ANSWER);
    }
    if (url === '/api/speak') {
      if (options.speakGate) {
        return options.speakGate;
      }
      const queued = options.speakResponses?.shift();
      if (queued) {
        return queued;
      }
      return jsonResponse({
        status: 'speaking',
        answer_id: 'ans-1',
        voice: 'forrest-synthetic-v1',
        activation_id: 'spk-live',
      });
    }
    if (url === '/api/stop') {
      if (options.stop) {
        return options.stop();
      }
      return jsonResponse(IDLE_SPEECH);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderReadyApp(props?: { activationTimeoutMs?: number }) {
  render(<App {...props} />);
  // Never click Capture while it is still disabled during backend load.
  await screen.findByText('Backend: online');
}

async function driveToReady(props?: { activationTimeoutMs?: number }) {
  await renderReadyApp(props);
  fireEvent.click(screen.getByRole('button', { name: 'Capture question' }));
  await screen.findByText(TRANSCRIPT_QUESTION);
  fireEvent.click(screen.getByRole('button', { name: 'Draft answer' }));
  await screen.findByText(/Based on your approved materials/);
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this answer/ }));
  await screen.findByText('State: Ready for review');
}

async function driveToSpeaking() {
  await driveToReady();
  fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
  await screen.findByText('State: Speaking');
}

async function flushAsyncWork(gate: Promise<Response>) {
  await act(async () => {
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('stale approval handling', () => {
  it('discards a delayed retrieval response after an approval change', async () => {
    let resolveRetrieve!: (response: Response) => void;
    const retrieveGate = new Promise<Response>((resolve) => {
      resolveRetrieve = resolve;
    });
    const fetchMock = stubFullApi({ retrieveGate });
    await renderReadyApp();
    fireEvent.click(screen.getByRole('button', { name: 'Capture question' }));
    await screen.findByText(TRANSCRIPT_QUESTION);
    fireEvent.click(screen.getByRole('button', { name: 'Draft answer' }));
    await screen.findByText('State: Retrieving evidence');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Exclude' }))[0]);
    await screen.findByText('1 of 2 sources approved for retrieval.');
    resolveRetrieve(jsonResponse({ evidence: EVIDENCE, searched_sources: 2 }));
    await flushAsyncWork(retrieveGate);

    expect(screen.getByText('State: Question captured')).toBeInTheDocument();
    expect(screen.queryByText(/Source evidence/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/answer', expect.anything());
  });

  it('discards a delayed answer response after an approval change', async () => {
    let resolveAnswer!: (response: Response) => void;
    const answerGate = new Promise<Response>((resolve) => {
      resolveAnswer = resolve;
    });
    stubFullApi({ answerGate });
    await renderReadyApp();
    fireEvent.click(screen.getByRole('button', { name: 'Capture question' }));
    await screen.findByText(TRANSCRIPT_QUESTION);
    fireEvent.click(screen.getByRole('button', { name: 'Draft answer' }));
    await screen.findByText('State: Verifying answer');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Exclude' }))[0]);
    await screen.findByText('1 of 2 sources approved for retrieval.');
    resolveAnswer(jsonResponse(GROUNDED_ANSWER));
    await flushAsyncWork(answerGate);

    expect(screen.getByText('State: Question captured')).toBeInTheDocument();
    expect(screen.queryByText(/Based on your approved materials/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Source evidence/)).not.toBeInTheDocument();
  });

  it('stops speech and invalidates the draft when approvals change during speaking', async () => {
    const fetchMock = stubFullApi();
    await driveToSpeaking();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Exclude' }))[0]);
    await screen.findByText('1 of 2 sources approved for retrieval.');

    expect(fetchMock).toHaveBeenCalledWith('/api/stop', expect.anything());
    expect(screen.getByText('State: Question captured')).toBeInTheDocument();
    expect(screen.queryByText(/Based on your approved materials/)).not.toBeInTheDocument();
  });

  it('aborts a source toggle when stopping fails during speaking', async () => {
    stubFullApi({
      stop: () => Promise.reject(new Error('network down')),
    });
    await driveToSpeaking();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Exclude' }))[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(screen.getByText('2 of 2 sources approved for retrieval.')).toBeInTheDocument();
    expect(screen.getByText('State: Speaking')).toBeInTheDocument();
  });
});

describe('speech interruption', () => {
  it('stops backend speech before resetting', async () => {
    const fetchMock = stubFullApi();
    await driveToSpeaking();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await screen.findByText('State: Idle');

    expect(fetchMock).toHaveBeenCalledWith('/api/stop', expect.anything());
    expect(screen.queryByText(TRANSCRIPT_QUESTION)).not.toBeInTheDocument();
  });

  it('keeps interruption usable when stopping fails', async () => {
    let stopCalls = 0;
    stubFullApi({
      stop: async () => {
        stopCalls += 1;
        if (stopCalls === 1) {
          return Promise.reject(new Error('network down'));
        }
        return jsonResponse(IDLE_SPEECH);
      },
    });
    await driveToSpeaking();
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(screen.getByText('State: Speaking')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    await screen.findByText('State: Ready for review');
  });
});

describe('speech lifecycle guards', () => {
  it('disables new tasks while speaking', async () => {
    stubFullApi();
    await driveToSpeaking();

    expect(screen.getByRole('button', { name: 'Capture question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Draft answer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeEnabled();
  });

  it('releases orphaned speech when reset lands during activation', async () => {
    let resolveSpeak!: (response: Response) => void;
    const speakGate = new Promise<Response>((resolve) => {
      resolveSpeak = resolve;
    });
    const fetchMock = stubFullApi({ speakGate });
    await renderReadyApp();
    fireEvent.click(screen.getByRole('button', { name: 'Capture question' }));
    await screen.findByText(TRANSCRIPT_QUESTION);
    fireEvent.click(screen.getByRole('button', { name: 'Draft answer' }));
    await screen.findByText(/Based on your approved materials/);
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this answer/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await screen.findByText('State: Idle');
    resolveSpeak(
      jsonResponse({
        status: 'speaking',
        answer_id: 'ans-1',
        voice: 'forrest-synthetic-v1',
      }),
    );
    await flushAsyncWork(speakGate);

    expect(fetchMock).toHaveBeenCalledWith('/api/stop', expect.anything());
    expect(screen.getByText('State: Idle')).toBeInTheDocument();
    expect(screen.queryByText(TRANSCRIPT_QUESTION)).not.toBeInTheDocument();
  });
});

describe('activation lifecycle', () => {
  const SPEAKING = {
    status: 'speaking',
    answer_id: 'ans-1',
    voice: 'forrest-synthetic-v1',
  };

  function deferredResponse() {
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { gate, resolve, reject };
  }

  it('keeps Interrupt available during delayed activation', async () => {
    const { gate: speakGate, resolve } = deferredResponse();
    stubFullApi({ speakGate });
    await driveToReady();
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
    await screen.findByText('State: Starting speech');

    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Capture question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Draft answer' })).toBeDisabled();

    resolve(jsonResponse(SPEAKING));
    await screen.findByText('State: Speaking');
  });

  it('prevents a late activation response from overwriting an interruption', async () => {
    const { gate: speakGate, resolve } = deferredResponse();
    const fetchMock = stubFullApi({ speakGate });
    await driveToReady();
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
    await screen.findByText('State: Starting speech');
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    await screen.findByText('State: Ready for review');
    resolve(jsonResponse(SPEAKING));
    await flushAsyncWork(speakGate);

    expect(screen.getByText('State: Ready for review')).toBeInTheDocument();
    expect(screen.queryByText('State: Speaking')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/stop')).toHaveLength(2);
  });

  it('returns a failed activation to Ready when cleanup confirms idle', async () => {
    const { gate: speakGate, reject } = deferredResponse();
    const fetchMock = stubFullApi({ speakGate });
    await driveToReady();
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
    await screen.findByText('State: Starting speech');
    reject(new Error('speak boom'));

    expect(await screen.findByRole('alert')).toHaveTextContent('speak boom');
    expect(screen.getByText('State: Ready for review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate Forrest' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith('/api/stop', expect.anything());
  });

  it('preserves a retryable stop when activation cleanup fails', async () => {
    const { gate: speakGate, reject } = deferredResponse();
    let stopCalls = 0;
    stubFullApi({
      speakGate,
      stop: async () => {
        stopCalls += 1;
        if (stopCalls === 1) {
          return Promise.reject(new Error('stop unreachable'));
        }
        return jsonResponse(IDLE_SPEECH);
      },
    });
    await driveToReady();
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
    await screen.findByText('State: Starting speech');
    reject(new Error('speak boom'));

    expect(await screen.findByRole('alert')).toHaveTextContent('stop unreachable');
    expect(screen.getByText('State: Starting speech')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    await screen.findByText('State: Ready for review');
  });

  it('offers a retry stop when cleanup fails after a reset', async () => {
    const { gate: speakGate, resolve } = deferredResponse();
    let stopCalls = 0;
    stubFullApi({
      speakGate,
      stop: async () => {
        stopCalls += 1;
        if (stopCalls === 2) {
          return Promise.reject(new Error('cleanup unreachable'));
        }
        return jsonResponse(IDLE_SPEECH);
      },
    });
    await driveToReady();
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
    await screen.findByText('State: Starting speech');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await screen.findByText('State: Idle');
    resolve(jsonResponse(SPEAKING));
    await flushAsyncWork(speakGate);

    expect(screen.getByText('State: Idle')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('cleanup unreachable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry stop' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'Retry stop' })).not.toBeInTheDocument();
  });

  it('prevents speech when approval is revoked during activation', async () => {
    const { gate: speakGate, resolve } = deferredResponse();
    const fetchMock = stubFullApi({ speakGate });
    await driveToReady();
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
    await screen.findByText('State: Starting speech');
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this answer/ }));
    resolve(jsonResponse(SPEAKING));
    await flushAsyncWork(speakGate);

    expect(fetchMock).toHaveBeenCalledWith('/api/stop', expect.anything());
    expect(screen.getByText('State: Ready for review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate Forrest' })).toBeDisabled();
  });

  it('stops speech when approval is revoked while speaking', async () => {
    const fetchMock = stubFullApi();
    await driveToSpeaking();
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this answer/ }));
    await screen.findByText('State: Ready for review');

    expect(fetchMock).toHaveBeenCalledWith('/api/stop', expect.anything());
    expect(screen.getByRole('checkbox', { name: /I reviewed this answer/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Activate Forrest' })).toBeDisabled();
  });

  it('keeps approval when stopping fails during revocation', async () => {
    stubFullApi({
      stop: () => Promise.reject(new Error('stop unreachable')),
    });
    await driveToSpeaking();
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this answer/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('stop unreachable');
    expect(screen.getByText('State: Speaking')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /I reviewed this answer/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeEnabled();
  });

  it('never starts speech late after an activation timeout', async () => {
    stubFullApi();
    await driveToReady({ activationTimeoutMs: 20 });
    // Install the slow speak response only now so the 40ms delay starts at
    // activation time, after the 20ms timeout is already armed.
    const fetchMock = stubFullApi({
      speakGate: new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(
            jsonResponse({
              status: 'speaking',
              answer_id: 'ans-1',
              voice: 'forrest-synthetic-v1',
            }),
          );
        }, 40);
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Speech activation timed out.');
    expect(screen.getByText('State: Ready for review')).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => url === '/api/stop')).toHaveLength(2);
    });
    expect(screen.queryByText('State: Speaking')).not.toBeInTheDocument();
  });

  it('scopes stale cleanup to the old activation', async () => {
    let resolveFirst!: (response: Response) => void;
    const firstGate = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondResponse = jsonResponse({
      status: 'speaking',
      answer_id: 'ans-1',
      voice: 'forrest-synthetic-v1',
      activation_id: 'spk-0002',
    });
    const fetchMock = stubFullApi({ speakResponses: [firstGate, Promise.resolve(secondResponse)] });
    await driveToReady();
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
    await screen.findByText('State: Starting speech');
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    await screen.findByText('State: Ready for review');
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
    await screen.findByText('State: Speaking');
    resolveFirst(
      jsonResponse({
        status: 'speaking',
        answer_id: 'ans-1',
        voice: 'forrest-synthetic-v1',
        activation_id: 'spk-0001',
      }),
    );
    await flushAsyncWork(firstGate);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const stopBodies = calls
      .filter(([url]) => url === '/api/stop')
      .map(([, init]) => JSON.parse(init.body as string));
    expect(stopBodies).toHaveLength(2);
    expect(stopBodies[0]).toEqual({});
    expect(stopBodies[1]).toEqual({ activation_id: 'spk-0001' });
    expect(screen.getByText('State: Speaking')).toBeInTheDocument();
  });

  it('preserves the retry control across new work', async () => {
    const { gate: speakGate, resolve } = deferredResponse();
    let stopCalls = 0;
    stubFullApi({
      speakGate,
      stop: async () => {
        stopCalls += 1;
        if (stopCalls === 2) {
          return Promise.reject(new Error('cleanup unreachable'));
        }
        return jsonResponse(IDLE_SPEECH);
      },
    });
    await driveToReady();
    fireEvent.click(screen.getByRole('button', { name: 'Activate Forrest' }));
    await screen.findByText('State: Starting speech');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await screen.findByText('State: Idle');
    resolve(jsonResponse(SPEAKING));
    await flushAsyncWork(speakGate);

    expect(await screen.findByRole('button', { name: 'Retry stop' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Capture question' }));
    await screen.findByText('State: Question captured');
    expect(screen.getByRole('button', { name: 'Retry stop' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('cleanup unreachable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry stop' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
