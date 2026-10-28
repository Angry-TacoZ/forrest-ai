import { describe, expect, it } from 'vitest';
import type { AnswerResponse, Evidence } from './api.ts';
import {
  canActivate,
  canInterrupt,
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
    expect(state.phase).toBe('activating');
    state = sessionReducer(
      state,
      {
        type: 'speak:done',
        speech: {
          status: 'speaking',
          answer_id: 'ans-grounded',
          voice: 'forrest-synthetic-v1',
          activation_id: 'spk-0001',
        },
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
      speech: {
        status: 'speaking',
        answer_id: 'ans-grounded',
        voice: 'forrest-synthetic-v1',
        activation_id: 'spk-0001',
      },
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

  it('moves through activating on the way to speaking', () => {
    const ready: SessionState = { ...initialSession, phase: 'ready', answer: grounded };
    expect(canInterrupt(ready)).toBe(false);
    const activating = sessionReducer(ready, { type: 'speak:start' });
    expect(activating.phase).toBe('activating');
    expect(canInterrupt(activating)).toBe(true);
    expect(canActivate(activating)).toBe(false);
    expect(phaseLabel('activating')).toBe('Starting speech');
  });

  it('returns a failed activation to ready when cleanup confirms idle', () => {
    const activating: SessionState = {
      ...initialSession,
      phase: 'activating',
      answer: grounded,
      answerApproved: true,
    };
    const state = sessionReducer(
      activating,
      { type: 'activation:failed', error: 'Speech activation timed out.' },
    );
    expect(state.phase).toBe('ready');
    expect(state.error).toBe('Speech activation timed out.');
    expect(state.answer).toBe(grounded);
    expect(canActivate(state)).toBe(true);
  });

  it('settles a stale activation only while still activating', () => {
    const activating: SessionState = {
      ...initialSession,
      phase: 'activating',
      answer: grounded,
      error: 'network down',
    };
    const settled = sessionReducer(activating, { type: 'activation:settled' });
    expect(settled.phase).toBe('ready');
    expect(settled.error).toBeNull();
    expect(settled.speech.status).toBe('idle');
    expect(sessionReducer(initialSession, { type: 'activation:settled' })).toBe(initialSession);
  });

  it('raises the retry flag when cleanup fails after invalidation', () => {
    const activating: SessionState = { ...initialSession, phase: 'activating' };
    const covered = sessionReducer(
      activating,
      { type: 'activation:unconfirmed', error: 'network down' },
    );
    expect(covered.phase).toBe('activating');
    expect(covered.stopUnconfirmed).toBe(false);

    const reset = sessionReducer(
      initialSession,
      { type: 'activation:unconfirmed', error: 'network down' },
    );
    expect(reset.phase).toBe('idle');
    expect(reset.error).toBe('network down');
    expect(reset.stopUnconfirmed).toBe(true);
  });

  it('clears the retry flag when speech is confirmed stopped', () => {
    const stranded: SessionState = {
      ...initialSession,
      error: 'network down',
      stopUnconfirmed: true,
    };
    const confirmed = sessionReducer(stranded, { type: 'stop:confirmed' });
    expect(confirmed.phase).toBe('idle');
    expect(confirmed.error).toBeNull();
    expect(confirmed.stopUnconfirmed).toBe(false);

    const speaking: SessionState = {
      ...initialSession,
      phase: 'speaking',
      stopUnconfirmed: true,
    };
    expect(sessionReducer(speaking, { type: 'stop:done' }).stopUnconfirmed).toBe(false);
  });

  it('preserves an unconfirmed stop across new work', () => {
    const stranded: SessionState = {
      ...initialSession,
      error: 'cleanup unreachable',
      stopUnconfirmed: true,
    };
    for (const action of [
      { type: 'capture:start', scenario: 'supported' },
      { type: 'sources:changed' },
      { type: 'reset' },
    ] as const) {
      const next = sessionReducer(stranded, action);
      expect(next.stopUnconfirmed).toBe(true);
      expect(next.error).toBe('cleanup unreachable');
    }
    expect(sessionReducer(stranded, { type: 'capture:start', scenario: 'supported' }).phase).toBe(
      'transcribing',
    );
  });

  it('clears fresh sessions without touching a clean slate', () => {
    const reset = sessionReducer(initialSession, { type: 'reset' });
    expect(reset).toBe(initialSession);
    const captured = sessionReducer(initialSession, { type: 'capture:start', scenario: 'supported' });
    expect(captured.stopUnconfirmed).toBe(false);
    expect(captured.error).toBeNull();
  });

  it('clears the retry flag once cleanup confirms idle', () => {
    const stranded: SessionState = {
      ...initialSession,
      phase: 'ready',
      answer: grounded,
      error: 'cleanup unreachable',
      stopUnconfirmed: true,
    };
    const failed = sessionReducer(stranded, { type: 'activation:failed', error: 'speak boom' });
    expect(failed.stopUnconfirmed).toBe(false);
    expect(failed.error).toBe('speak boom');
  });

  it('raises no retry flag when a phase-level control already covers speech', () => {
    const speaking: SessionState = { ...initialSession, phase: 'speaking' };
    const state = sessionReducer(
      speaking,
      { type: 'activation:unconfirmed', error: 'network down' },
    );
    expect(state.phase).toBe('speaking');
    expect(state.stopUnconfirmed).toBe(false);
    expect(state.error).toBe('network down');
  });
});
