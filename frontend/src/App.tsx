import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import './App.css';
import { ACTIVATION_TIMEOUT_MS, ApiError, activateSpeech, api, errorMessage } from './api.ts';
import type { Scenario, Source } from './api.ts';
import {
  canActivate,
  canInterrupt,
  initialSession,
  phaseLabel,
  sessionReducer,
} from './session.ts';

type BackendStatus = 'checking' | 'online' | 'offline';

const BUSY_PHASES = ['transcribing', 'retrieving', 'verifying'];

interface AppProps {
  activationTimeoutMs?: number;
}

export default function App({ activationTimeoutMs = ACTIVATION_TIMEOUT_MS }: AppProps = {}) {
  const [session, dispatch] = useReducer(sessionReducer, initialSession);
  const [sources, setSources] = useState<Source[]>([]);
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [scenario, setScenario] = useState<Scenario>('supported');
  const [backend, setBackend] = useState<BackendStatus>('checking');
  // An approval request is in flight; the checkbox stays disabled so rapid
  // check/uncheck toggles cannot interleave approve and revoke calls.
  const [approvalPending, setApprovalPending] = useState(false);
  // A selection sync is in flight; source buttons stay disabled so a second
  // toggle cannot start from the same captured selection and silently undo
  // the first one server-side.
  const [selectionPending, setSelectionPending] = useState(false);
  // Bumped whenever the approval selection or session is invalidated so
  // in-flight transcribe/retrieve/answer/speak responses cannot restore
  // stale data. Every stop-initiating action claims a ticket first so a
  // superseded stop never overwrites a newer transition.
  const ticketRef = useRef(0);
  // Monotonic activation counter: stale cleanup skips its settled
  // transition when a newer activation already owns the phase.
  const epochRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        await api.health();
        const data = await api.sources();
        if (cancelled) {
          return;
        }
        setSources(data.sources);
        // A reload must not resurrect exclusions the backend still holds: a
        // synced selection (epoch > 0) wins over the per-source defaults.
        let initialApproved = Object.fromEntries(
          data.sources.map((source) => [source.id, source.approved_default]),
        );
        try {
          const selection = await api.getSelection();
          if (selection.epoch > 0) {
            const synced = new Set(selection.approved_source_ids);
            initialApproved = Object.fromEntries(
              data.sources.map((source) => [source.id, synced.has(source.id)]),
            );
          }
        } catch {
          // Fall through to defaults when the selection is unavailable.
        }
        if (cancelled) {
          return;
        }
        // Reconcile orphaned backend speech (e.g. after a reload during
        // speech): the fresh session cannot own it, so stop it. A failure
        // keeps a retry control instead of stranding speech silently.
        try {
          const speech = await api.speech();
          if (cancelled) {
            return;
          }
          if (speech.status === 'speaking') {
            await api.stop();
          }
        } catch (error) {
          if (cancelled) {
            return;
          }
          dispatch({ type: 'load:speech-unconfirmed', error: errorMessage(error) });
        }
        if (cancelled) {
          return;
        }
        setApproved(initialApproved);
        setBackend('online');
      } catch {
        if (!cancelled) {
          setBackend('offline');
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const approvedIds = sources.filter((source) => approved[source.id]).map((source) => source.id);
  const busy = BUSY_PHASES.includes(session.phase);
  // Capture and Draft stay disabled while speech is active or starting: a new
  // task must never strand backend speech without an interruption control.
  const speechActive = session.phase === 'speaking' || session.phase === 'activating';

  // Stop backend speech when it may be active. Returns false when the stop
  // failed (session keeps a retryable control) or was superseded, in which
  // case the caller must not proceed with its own transition.
  const stopIfSpeechActive = useCallback(async (): Promise<boolean> => {
    if (session.phase !== 'speaking' && session.phase !== 'activating') {
      return true;
    }
    const ticket = ++ticketRef.current;
    try {
      await api.stop();
    } catch (error) {
      if (ticket !== ticketRef.current) {
        return false;
      }
      dispatch({ type: 'stop:failed', error: errorMessage(error) });
      return false;
    }
    if (ticket !== ticketRef.current) {
      return false;
    }
    return true;
  }, [session.phase]);

  const toggleSource = useCallback(
    async (id: string) => {
      // Never strand backend speech behind a revoked approval: stop first,
      // and abort the toggle entirely when the stop fails.
      if (!(await stopIfSpeechActive())) {
        return;
      }
      const nextApproved = { ...approved, [id]: !approved[id] };
      const nextIds = sources
        .filter((source) => nextApproved[source.id])
        .map((source) => source.id);
      // Sync the selection before invalidating locally: the backend epoch
      // bump is what stales every prior approval server-side.
      setSelectionPending(true);
      try {
        await api.setSelection(nextIds);
      } catch (error) {
        dispatch({ type: 'stop:failed', error: errorMessage(error) });
        return;
      } finally {
        setSelectionPending(false);
      }
      ticketRef.current += 1;
      setApproved(nextApproved);
      dispatch({ type: 'sources:changed' });
    },
    [approved, sources, stopIfSpeechActive],
  );

  const approveAnswer = useCallback(async () => {
    if (!session.answer || session.answer.status !== 'grounded') {
      return;
    }
    // The approval below belongs to this answer only: if the session moved
    // on (reset, new draft, changed sources), the late response is dropped
    // instead of marking a different answer as reviewed.
    const ticket = ticketRef.current;
    setApprovalPending(true);
    try {
      await api.approve(session.answer.answer_id, approvedIds);
    } catch (error) {
      if (ticket !== ticketRef.current) {
        return;
      }
      // Phase is kept so Interrupt stays usable when speech may be active.
      dispatch({ type: 'stop:failed', error: errorMessage(error) });
      return;
    } finally {
      setApprovalPending(false);
    }
    if (ticket !== ticketRef.current) {
      return;
    }
    dispatch({ type: 'approval:set', approved: true });
  }, [approvedIds, session.answer]);

  const revokeApproval = useCallback(async () => {
    if (!session.answer) {
      return;
    }
    // Like approvals, a revoke response belongs to this session only: if the
    // session moved on, the server-side revoke still stands but no local
    // state is touched.
    const ticket = ticketRef.current;
    setApprovalPending(true);
    // Revoke before stopping: when the revoke fails, nothing has changed
    // and the approval stays checked. Once the revoke succeeds, the local
    // approval is cleared immediately so the checkbox never claims an
    // approval the backend no longer holds, even if stopping fails next.
    try {
      await api.revoke(session.answer.answer_id);
    } catch (error) {
      if (ticket !== ticketRef.current) {
        return;
      }
      dispatch({ type: 'stop:failed', error: errorMessage(error) });
      return;
    } finally {
      setApprovalPending(false);
    }
    if (ticket !== ticketRef.current) {
      return;
    }
    dispatch({ type: 'approval:set', approved: false });
    const hadSpeech = session.phase === 'speaking' || session.phase === 'activating';
    if (!(await stopIfSpeechActive())) {
      return;
    }
    ticketRef.current += 1;
    if (hadSpeech) {
      dispatch({ type: 'stop:done' });
    }
  }, [session.answer, session.phase, stopIfSpeechActive]);

  const capture = useCallback(async () => {
    const ticket = ++ticketRef.current;
    dispatch({ type: 'capture:start', scenario });
    try {
      const transcript = await api.transcribe(scenario);
      if (ticket !== ticketRef.current) {
        return;
      }
      dispatch({ type: 'capture:done', question: transcript.question });
    } catch (error) {
      if (ticket !== ticketRef.current) {
        return;
      }
      dispatch({ type: 'fail', error: errorMessage(error) });
    }
  }, [scenario]);

  const draft = useCallback(async () => {
    const ticket = ticketRef.current;
    dispatch({ type: 'draft:start' });
    try {
      const found = await api.retrieve(session.question, approvedIds);
      if (ticket !== ticketRef.current) {
        return;
      }
      dispatch({
        type: 'draft:evidence',
        evidence: found.evidence,
        searchedSources: found.searched_sources,
      });
      const answer = await api.answer(session.question, found.evidence, approvedIds);
      if (ticket !== ticketRef.current) {
        return;
      }
      dispatch({ type: 'draft:done', answer });
    } catch (error) {
      if (ticket !== ticketRef.current) {
        return;
      }
      dispatch({ type: 'fail', error: errorMessage(error) });
    }
  }, [session.question, approvedIds]);

  const activate = useCallback(async () => {
    if (!session.answer) {
      return;
    }
    const ticket = ticketRef.current;
    const epoch = ++epochRef.current;
    // Release one specific orphaned activation: the id-scoped stop cannot
    // touch newer speech, and settled/unconfirmed transitions are skipped
    // when a newer activation already owns backend state.
    const releaseActivation = (activationId: string | null) => {
      void (async () => {
        try {
          await api.stop(activationId);
          if (epoch === epochRef.current) {
            dispatch({ type: 'activation:settled' });
          }
        } catch (error) {
          if (epoch !== epochRef.current) {
            return;
          }
          dispatch({ type: 'activation:unconfirmed', error: errorMessage(error) });
        }
      })();
    };
    dispatch({ type: 'speak:start' });
    try {
      const speech = await activateSpeech(session.answer.answer_id, activationTimeoutMs, (late) =>
        releaseActivation(late.activation_id),
      );
      if (ticket !== ticketRef.current) {
        // Reset or invalidated while activating: release the orphaned backend
        // speech instead of restoring a session the candidate already left.
        releaseActivation(speech.activation_id);
        return;
      }
      dispatch({ type: 'speak:done', speech });
    } catch (error) {
      if (epoch !== epochRef.current) {
        // A newer activation owns backend state; this failure must not
        // touch it (no stop, no ticket bump, no state transition).
        return;
      }
      if (error instanceof ApiError && error.status === 403) {
        // The backend refused authorization (unapproved, revoked, stale, or
        // expired): resync the checkbox instead of trusting local state.
        dispatch({ type: 'approval:set', approved: false });
      }
      // Ambiguous failure: the backend may have started speech even though
      // the request failed or timed out. Ownership is rechecked after the
      // cleanup await, since a newer activation may have begun meanwhile.
      const stale = ticket !== ticketRef.current;
      try {
        await api.stop();
      } catch (cleanupError) {
        if (epoch !== epochRef.current) {
          return;
        }
        dispatch(
          stale
            ? { type: 'activation:unconfirmed', error: errorMessage(cleanupError) }
            : { type: 'stop:failed', error: errorMessage(cleanupError) },
        );
        return;
      }
      if (epoch !== epochRef.current) {
        return;
      }
      dispatch(
        stale
          ? { type: 'activation:settled' }
          : { type: 'activation:failed', error: errorMessage(error) },
      );
    }
  }, [session.answer, activationTimeoutMs]);

  const interrupt = useCallback(async () => {
    const ticket = ++ticketRef.current;
    try {
      await api.stop();
      if (ticket !== ticketRef.current) {
        return;
      }
      dispatch({ type: 'stop:done' });
    } catch (error) {
      if (ticket !== ticketRef.current) {
        return;
      }
      // Stay in the speaking/activating phase so the candidate can retry.
      dispatch({ type: 'stop:failed', error: errorMessage(error) });
    }
  }, []);

  const reset = useCallback(async () => {
    // Revoke first so a failed reset never leaves a server approval behind
    // for an answer the session no longer shows.
    if (session.answer) {
      try {
        await api.revoke(session.answer.answer_id);
      } catch (error) {
        dispatch({ type: 'stop:failed', error: errorMessage(error) });
        return;
      }
    }
    if (!(await stopIfSpeechActive())) {
      return;
    }
    ticketRef.current += 1;
    dispatch({ type: 'reset' });
  }, [session.answer, stopIfSpeechActive]);

  const retryStop = useCallback(async () => {
    try {
      await api.stop();
      dispatch({ type: 'stop:confirmed' });
    } catch (error) {
      dispatch({ type: 'stop:failed', error: errorMessage(error) });
    }
  }, []);

  const stages = [
    { label: 'Question captured', done: session.question !== '' },
    { label: 'Evidence retrieved', done: session.evidence.length > 0 || session.answer !== null },
    { label: 'Answer verified', done: session.answer?.status === 'grounded' },
    { label: 'Candidate approved', done: session.answerApproved },
    { label: 'Spoken', done: session.spoken },
  ];

  return (
    <div className="workspace">
      <header className="topbar">
        <div>
          <h1>Forrest AI — Interview Workspace</h1>
          <p className="subtitle">Consented, source-grounded answers. Mock services, fictional data.</p>
        </div>
        <div className="status-cluster">
          <span className={`pill backend-${backend}`}>Backend: {backend}</span>
          <span className="pill phase">State: {phaseLabel(session.phase)}</span>
        </div>
      </header>

      <p className="disclosure" role="note">
        Controlled demonstration: interviewer consent is assumed, every answer needs candidate
        approval before Forrest speaks, and unsupported questions are blocked, never invented.
      </p>

      {session.error && (
        <p className="error" role="alert">
          {session.error}{' '}
          {session.stopUnconfirmed && (
            <button type="button" onClick={retryStop} className="retry">
              Retry stop
            </button>
          )}
        </p>
      )}

      <main className="grid">
        <section aria-labelledby="library-heading" className="panel">
          <h2 id="library-heading">Knowledge library</h2>
          <p className="hint">
            {approvedIds.length} of {sources.length} sources approved for retrieval.
          </p>
          <ul className="source-list">
            {sources.map((source) => (
              <li key={source.id} className="source">
                <div>
                  <strong>{source.title}</strong>
                  <p>{source.summary}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void toggleSource(source.id);
                  }}
                  aria-pressed={approved[source.id] === true}
                  disabled={selectionPending}
                >
                  {approved[source.id] ? 'Exclude' : 'Approve'}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="interview-heading" className="panel">
          <h2 id="interview-heading">Interview</h2>
          <fieldset>
            <legend>Demo scenario</legend>
            <label>
              <input
                type="radio"
                name="scenario"
                checked={scenario === 'supported'}
                onChange={() => {
                  setScenario('supported');
                }}
              />
              Supported question
            </label>
            <label>
              <input
                type="radio"
                name="scenario"
                checked={scenario === 'unsupported'}
                onChange={() => {
                  setScenario('unsupported');
                }}
              />
              Unsupported question
            </label>
          </fieldset>
          <div className="row">
            <button
              type="button"
              onClick={capture}
              disabled={busy || backend !== 'online' || speechActive}
            >
              Capture question
            </button>
            <button
              type="button"
              onClick={draft}
              disabled={session.question === '' || busy || speechActive}
            >
              Draft answer
            </button>
            <button
              type="button"
              onClick={() => {
                void reset();
              }}
            >
              Reset
            </button>
          </div>

          {session.question !== '' && (
            <div className="transcript">
              <h3>Transcript</h3>
              <p>{session.question}</p>
            </div>
          )}

          {session.evidence.length > 0 && (
            <div className="evidence">
              <h3>Source evidence ({session.searchedSources} sources searched)</h3>
              <ol>
                {session.evidence.map((item) => (
                  <li key={item.source_id}>
                    <strong>{item.source_title}</strong>{' '}
                    <span className="relevance">{item.relevance.toFixed(2)}</span>
                    <p>{item.excerpt}</p>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {session.answer?.status === 'grounded' && (
            <div className="answer">
              <h3>Draft answer</h3>
              <p>{session.answer.answer}</p>
            </div>
          )}

          {session.answer?.status === 'blocked' && (
            <div className="blocked" role="alert">
              <h3>Answer blocked</h3>
              <p>{session.answer.reason}</p>
            </div>
          )}
        </section>

        <section aria-labelledby="review-heading" className="panel">
          <h2 id="review-heading">Review and speak</h2>
          <ol className="stages">
            {stages.map((stage) => (
              <li key={stage.label} className={stage.done ? 'done' : 'todo'}>
                {stage.done ? '✓' : '○'} {stage.label}
              </li>
            ))}
          </ol>
          <label className="approval">
            <input
              type="checkbox"
              checked={session.answerApproved}
              disabled={session.answer?.status !== 'grounded' || approvalPending}
              onChange={(event) => {
                if (event.target.checked) {
                  void approveAnswer();
                } else {
                  void revokeApproval();
                }
              }}
            />
            I reviewed this answer and approve it.
          </label>
          <div className="row">
            <button
              type="button"
              onClick={activate}
              disabled={!canActivate(session) || selectionPending}
            >
              Activate Forrest
            </button>
            <button
              type="button"
              onClick={interrupt}
              disabled={!canInterrupt(session)}
              className="danger"
            >
              Interrupt
            </button>
          </div>
          <p className="hint">
            Voice: {session.speech.voice} (synthetic mock). Speaking requires an approved, grounded
            answer.
          </p>
        </section>
      </main>

      <footer>
        <p>PR #1 foundation: deterministic mocks only — no paid APIs. Fictional candidate data.</p>
      </footer>
    </div>
  );
}
