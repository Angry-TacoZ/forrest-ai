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
  activation_id: string | null;
}

export interface ApprovalStatus {
  answer_id: string;
  status: 'approved' | 'unapproved';
  revoked: boolean;
  epoch: number;
}

export interface SelectionState {
  approved_source_ids: string[];
  epoch: number;
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

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

export const ACTIVATION_TIMEOUT_MS = 15000;

export async function activateSpeech(
  answerId: string,
  timeoutMs: number,
  onLateSuccess?: (speech: SpeechState) => void,
): Promise<SpeechState> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const speakPromise = api.speak(answerId);
  // Keep observing the request after a timeout wins: a late success means
  // the backend may have started speech, so the caller must clean up.
  // A late rejection needs no action (the timeout path already cleaned up).
  void speakPromise.then(
    (speech) => {
      if (timedOut) {
        onLateSuccess?.(speech);
      }
    },
    () => {},
  );
  try {
    return await Promise.race([
      speakPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('Speech activation timed out.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
  approve: (answer_id: string, approved_source_ids: string[], epoch: number) =>
    post<ApprovalStatus>('/api/approve', { answer_id, approved_source_ids, epoch }),
  revoke: (answer_id: string) => post<ApprovalStatus>('/api/revoke', { answer_id }),
  setSelection: (approved_source_ids: string[]) =>
    put<SelectionState>('/api/selection', { approved_source_ids }),
  getSelection: () => request<SelectionState>('/api/selection'),
  speak: (answer_id: string) => post<SpeechState>('/api/speak', { answer_id }),
  stop: (activationId?: string | null) =>
    post<SpeechState>('/api/stop', activationId ? { activation_id: activationId } : {}),
  speech: () => request<SpeechState>('/api/speech'),
};
