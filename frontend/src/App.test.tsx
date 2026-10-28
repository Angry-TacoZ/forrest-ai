import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
