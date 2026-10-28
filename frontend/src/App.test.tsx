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
      return jsonResponse({
        status: 'speaking',
        answer_id: 'ans-1',
        voice: 'forrest-synthetic-v1',
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

async function driveToSpeaking() {
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Capture question' }));
  await screen.findByText(TRANSCRIPT_QUESTION);
  fireEvent.click(screen.getByRole('button', { name: 'Draft answer' }));
  await screen.findByText(/Based on your approved materials/);
  fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this answer/ }));
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
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Capture question' }));
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
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Capture question' }));
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
