import { describe, expect, it } from 'vitest';
import type { AnswerResponse, Evidence } from './api.ts';
import {
  canActivate,
  initialSession,
  phaseLabel,
  sessionReducer,
} from './session.ts';
import type { SessionState } from './session.ts';

const evidence: Evidence[] = [
  {
    source_id: 'resume-summary',
    source_title: 'Resume summary (fictional)',
    excerpt: 'Four years of Python backend experience.',
    relevance: 0.75,
  },
];

const grounded: AnswerResponse = {
  status: 'grounded',
  answer: 'Based on your approved materials: ...',
  claims: [{ text: 'Four years of Python backend experience.', source_ids: ['resume-summary'] }],
  reason: '',
  answer_id: 'ans-grounded',
};

const blocked: AnswerResponse = {
  status: 'blocked',
  answer: '',
  claims: [],
  reason: 'No approved evidence supports this question.',
  answer_id: 'ans-blocked',
};

describe('session reducer', () => {
  it('captures a question and drafts a grounded answer', () => {
    let state = initialSession;
    state = sessionReducer(state, { type: 'capture:start', scenario: 'supported' });
    expect(state.phase).toBe('transcribing');
    state = sessionReducer(state, { type: 'capture:done', question: 'Q?' });
    state = sessionReducer(state, { type: 'draft:start' });
    state = sessionReducer(state, { type: 'draft:evidence', evidence, searchedSources: 3 });
    expect(state.phase).toBe('verifying');
    state = sessionReducer(state, { type: 'draft:done', answer: grounded });
    expect(state.phase).toBe('ready');
    expect(state.answerApproved).toBe(false);
  });

  it('moves to blocked when the answer is unsupported', () => {
    let state = sessionReducer(initialSession, { type: 'capture:start', scenario: 'unsupported' });
    state = sessionReducer(state, { type: 'capture:done', question: 'Q?' });
    state = sessionReducer(state, { type: 'draft:start' });
    state = sessionReducer(state, { type: 'draft:evidence', evidence: [], searchedSources: 3 });
    state = sessionReducer(state, { type: 'draft:done', answer: blocked });
    expect(state.phase).toBe('blocked');
    expect(canActivate(state)).toBe(false);
  });

  it('gates activation on review approval', () => {
    let state: SessionState = { ...initialSession, phase: 'ready', answer: grounded };
    expect(canActivate(state)).toBe(false);
    state = sessionReducer(state, { type: 'approval:set', approved: true });
    expect(canActivate(state)).toBe(true);
  });

  it('tracks speaking and returns to ready after interruption', () => {
    let state: SessionState = { ...initialSession, phase: 'ready', answer: grounded };
    state = sessionReducer(state, { type: 'approval:set', approved: true });
    state = sessionReducer(state, { type: 'speak:start' });
    expect(state.phase).toBe('ready');
    state = sessionReducer(
      state,
      {
        type: 'speak:done',
        speech: { status: 'speaking', answer_id: 'ans-grounded', voice: 'forrest-synthetic-v1' },
      },
    );
    expect(state.phase).toBe('speaking');
    expect(state.spoken).toBe(true);
    state = sessionReducer(state, { type: 'stop:done' });
    expect(state.phase).toBe('ready');
    expect(state.speech.status).toBe('idle');
  });

  it('records failures and resets cleanly', () => {
    const failed = sessionReducer(initialSession, { type: 'fail', error: 'Backend down' });
    expect(failed.phase).toBe('error');
    expect(failed.error).toBe('Backend down');
    expect(sessionReducer(failed, { type: 'reset' })).toEqual(initialSession);
  });

  it('labels every phase', () => {
    expect(phaseLabel('idle')).toBe('Idle');
    expect(phaseLabel('blocked')).toBe('Answer blocked');
    expect(phaseLabel('speaking')).toBe('Speaking');
  });

  it('invalidates the draft when approvals change', () => {
    const ready: SessionState = {
      ...initialSession,
      phase: 'ready',
      question: 'Q?',
      evidence,
      searchedSources: 3,
      answer: grounded,
      answerApproved: true,
      spoken: true,
    };
    const state = sessionReducer(ready, { type: 'sources:changed' });
    expect(state.phase).toBe('transcribed');
    expect(state.question).toBe('Q?');
    expect(state.evidence).toEqual([]);
    expect(state.answer).toBeNull();
    expect(state.answerApproved).toBe(false);
    expect(state.spoken).toBe(false);
    expect(canActivate(state)).toBe(false);
  });

  it('returns to idle when approvals change before any question', () => {
    const state = sessionReducer(initialSession, { type: 'sources:changed' });
    expect(state).toEqual(initialSession);
  });

  it('clears speech state when approvals change after stopping', () => {
    const speaking: SessionState = {
      ...initialSession,
      phase: 'speaking',
      question: 'Q?',
      answer: grounded,
      speech: { status: 'speaking', answer_id: 'ans-grounded', voice: 'forrest-synthetic-v1' },
    };
    const state = sessionReducer(speaking, { type: 'sources:changed' });
    expect(state.phase).toBe('transcribed');
    expect(state.speech.status).toBe('idle');
    expect(state.speech.answer_id).toBeNull();
  });

  it('preserves the phase when stopping fails', () => {
    const speaking: SessionState = {
      ...initialSession,
      phase: 'speaking',
      question: 'Q?',
      answer: grounded,
    };
    const state = sessionReducer(speaking, { type: 'stop:failed', error: 'network down' });
    expect(state.phase).toBe('speaking');
    expect(state.error).toBe('network down');
    expect(state.answer).toBe(grounded);
  });
});
