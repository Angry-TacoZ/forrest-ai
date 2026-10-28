import type { AnswerResponse, Evidence, Scenario, SpeechState } from './api.ts';

export type Phase =
  | 'idle'
  | 'transcribing'
  | 'transcribed'
  | 'retrieving'
  | 'verifying'
  | 'ready'
  | 'blocked'
  | 'activating'
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
  stopUnconfirmed: boolean;
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
  speech: { status: 'idle', answer_id: null, voice: 'forrest-synthetic-v1', activation_id: null },
  spoken: false,
  stopUnconfirmed: false,
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
  | { type: 'stop:failed'; error: string }
  | { type: 'stop:confirmed' }
  | { type: 'activation:failed'; error: string }
  | { type: 'activation:settled' }
  | { type: 'activation:unconfirmed'; error: string }
  | { type: 'load:speech-unconfirmed'; error: string }
  | { type: 'sources:changed' }
  | { type: 'fail'; error: string }
  | { type: 'reset' };

// An unconfirmed stop means backend speech may still be active. Fresh
// lifecycle transitions preserve that flag and its error so the candidate
// never loses the retry control by starting new work.
function preserveUnconfirmedStop<T extends SessionState>(next: T, current: SessionState): T {
  if (!current.stopUnconfirmed) {
    return next;
  }
  return { ...next, stopUnconfirmed: true, error: current.error };
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'capture:start':
      return preserveUnconfirmedStop(
        {
          ...initialSession,
          phase: 'transcribing',
          scenario: action.scenario,
        },
        state,
      );
    case 'capture:done':
      return { ...state, phase: 'transcribed', question: action.question };
    case 'draft:start':
      return {
        ...state,
        phase: 'retrieving',
        error: state.stopUnconfirmed ? state.error : null,
      };
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
      return {
        ...state,
        phase: 'activating',
        error: state.stopUnconfirmed ? state.error : null,
      };
    case 'speak:done':
      return {
        ...state,
        phase: 'speaking',
        speech: action.speech,
        spoken: true,
        stopUnconfirmed: false,
        error: null,
      };
    case 'stop:done':
      return {
        ...state,
        phase: 'ready',
        speech: { ...state.speech, status: 'idle', answer_id: null, activation_id: null },
        stopUnconfirmed: false,
        error: null,
      };
    case 'stop:failed':
      // Keep the phase so the Interrupt control stays usable for a retry.
      return { ...state, error: action.error };
    case 'stop:confirmed':
      // A retry stop succeeded after the session had moved on: clear the
      // flag without touching the current phase.
      return { ...state, stopUnconfirmed: false, error: null };
    case 'activation:failed':
      // Speak failed but a confirmatory stop succeeded: the backend is idle,
      // the answer is intact, and activation can be retried.
      return { ...state, phase: 'ready', stopUnconfirmed: false, error: action.error };
    case 'activation:settled':
      // A late activation response arrived after invalidation and cleanup
      // confirmed the backend idle. Only unwind a phase that is still
      // waiting on activation; never revive reset or invalidated sessions.
      if (state.phase !== 'activating') {
        return state;
      }
      return {
        ...state,
        phase: 'ready',
        speech: { ...state.speech, status: 'idle', answer_id: null, activation_id: null },
        stopUnconfirmed: false,
        error: null,
      };
    case 'activation:unconfirmed':
      // Cleanup failed after invalidation: backend speech may be active. When
      // no phase-level stop control covers the current phase, raise the flag
      // that renders the retry control in the error banner.
      return {
        ...state,
        error: action.error,
        stopUnconfirmed: state.phase !== 'activating' && state.phase !== 'speaking',
      };
    case 'load:speech-unconfirmed':
      // Startup found backend speech it cannot own and the cleanup stop
      // failed: keep the error and its retry control until the backend
      // confirms idle, without touching the fresh session phase.
      return { ...state, error: action.error, stopUnconfirmed: true };
    case 'sources:changed':
      // Approval edits invalidate the draft, evidence, and candidate approval.
      // The question is kept so the candidate can re-draft under the new set.
      return preserveUnconfirmedStop(
        {
          ...state,
          phase: state.question === '' ? 'idle' : 'transcribed',
          evidence: [],
          searchedSources: 0,
          answer: null,
          answerApproved: false,
          speech: { status: 'idle', answer_id: null, voice: state.speech.voice, activation_id: null },
          spoken: false,
          stopUnconfirmed: false,
          error: null,
        },
        state,
      );
    case 'fail':
      return { ...state, phase: 'error', error: action.error };
    case 'reset':
      return preserveUnconfirmedStop(initialSession, state);
  }
}

export function canActivate(state: SessionState): boolean {
  return (
    state.phase === 'ready' &&
    state.answer?.status === 'grounded' &&
    state.answerApproved
  );
}

export function canInterrupt(state: SessionState): boolean {
  return state.phase === 'speaking' || state.phase === 'activating';
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
    case 'activating':
      return 'Starting speech';
    case 'speaking':
      return 'Speaking';
    case 'error':
      return 'Error';
  }
}
