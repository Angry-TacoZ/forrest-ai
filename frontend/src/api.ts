export type Scenario = 'supported' | 'unsupported';

export interface Source {
  id: string;
  title: string;
  kind: string;
  summary: string;
  approved_default: boolean;
}

export interface Transcript {
  question: string;
  scenario: string;
  engine: string;
  duration_ms: number;
}

export interface Evidence {
  source_id: string;
  source_title: string;
  excerpt: string;
  relevance: number;
}

export interface RetrieveResponse {
  evidence: Evidence[];
  searched_sources: number;
}

export interface Claim {
  text: string;
  source_ids: string[];
}

export interface AnswerResponse {
  status: 'grounded' | 'blocked';
  answer: string;
  claims: Claim[];
  reason: string;
  answer_id: string;
}

export interface SpeechState {
  status: 'idle' | 'speaking';
  answer_id: string | null;
  voice: string;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `Backend error ${error.status}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail ?? detail;
    } catch {
      // Fall through to status text when the error has no JSON body.
    }
    throw new ApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export const api = {
  health: () =>
    request<{ status: string; service: string; version: string }>('/api/health'),
  sources: () => request<{ sources: Source[] }>('/api/sources'),
  transcribe: (scenario: Scenario) =>
    post<Transcript>('/api/transcribe', { scenario }),
  retrieve: (question: string, approved_source_ids: string[]) =>
    post<RetrieveResponse>('/api/retrieve', { question, approved_source_ids }),
  answer: (question: string, evidence: Evidence[], approved_source_ids: string[]) =>
    post<AnswerResponse>('/api/answer', { question, evidence, approved_source_ids }),
  speak: (answer_id: string) => post<SpeechState>('/api/speak', { answer_id }),
  stop: () => post<SpeechState>('/api/stop', {}),
  speech: () => request<SpeechState>('/api/speech'),
};
