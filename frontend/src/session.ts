import type { AnswerResponse, Evidence, Scenario, SpeechState } from './api.ts';

export type Phase =
  | 'idle'
  | 'transcribing'
  | 'transcribed'
  | 'retrieving'
  | 'verifying'
  | 'ready'
  | 'blocked'
  | 'speaking'
  | 'error';

export interface SessionState {
  phase: Phase;
  scenario: Scenario | null;
  question: string;
  evidence: Evidence[];
  searchedSources: number;
  answer: AnswerResponse | null;
  answerApproved: boolean;
  speech: SpeechState;
  spoken: boolean;
  error: string | null;
}

export const initialSession: SessionState = {
  phase: 'idle',
  scenario: null,
  question: '',
  evidence: [],
  searchedSources: 0,
  answer: null,
  answerApproved: false,
  speech: { status: 'idle', answer_id: null, voice: 'forrest-synthetic-v1' },
  spoken: false,
  error: null,
};

export type SessionAction =
  | { type: 'capture:start'; scenario: Scenario }
  | { type: 'capture:done'; question: string }
  | { type: 'draft:start' }
  | { type: 'draft:evidence'; evidence: Evidence[]; searchedSources: number }
  | { type: 'draft:done'; answer: AnswerResponse }
  | { type: 'approval:set'; approved: boolean }
  | { type: 'speak:start' }
  | { type: 'speak:done'; speech: SpeechState }
  | { type: 'stop:done' }
  | { type: 'fail'; error: string }
  | { type: 'reset' };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'capture:start':
      return {
        ...initialSession,
        phase: 'transcribing',
        scenario: action.scenario,
      };
    case 'capture:done':
      return { ...state, phase: 'transcribed', question: action.question };
    case 'draft:start':
      return { ...state, phase: 'retrieving', error: null };
    case 'draft:evidence':
      return {
        ...state,
        phase: 'verifying',
        evidence: action.evidence,
        searchedSources: action.searchedSources,
      };
    case 'draft:done':
      return {
        ...state,
        phase: action.answer.status === 'grounded' ? 'ready' : 'blocked',
        answer: action.answer,
        answerApproved: false,
      };
    case 'approval:set':
      return { ...state, answerApproved: action.approved };
    case 'speak:start':
      return { ...state, error: null };
    case 'speak:done':
      return { ...state, phase: 'speaking', speech: action.speech, spoken: true };
    case 'stop:done':
      return {
        ...state,
        phase: 'ready',
        speech: { ...state.speech, status: 'idle', answer_id: null },
      };
    case 'fail':
      return { ...state, phase: 'error', error: action.error };
    case 'reset':
      return initialSession;
  }
}

export function canActivate(state: SessionState): boolean {
  return (
    state.phase === 'ready' &&
    state.answer?.status === 'grounded' &&
    state.answerApproved
  );
}

export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case 'idle':
      return 'Idle';
    case 'transcribing':
      return 'Capturing question';
    case 'transcribed':
      return 'Question captured';
    case 'retrieving':
      return 'Retrieving evidence';
    case 'verifying':
      return 'Verifying answer';
    case 'ready':
      return 'Ready for review';
    case 'blocked':
      return 'Answer blocked';
    case 'speaking':
      return 'Speaking';
    case 'error':
      return 'Error';
  }
}
