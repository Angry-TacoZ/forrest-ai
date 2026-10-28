import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import './App.css';
import { api, errorMessage } from './api.ts';
import type { Scenario, Source } from './api.ts';
import { canActivate, initialSession, phaseLabel, sessionReducer } from './session.ts';

type BackendStatus = 'checking' | 'online' | 'offline';

const BUSY_PHASES = ['transcribing', 'retrieving', 'verifying'];

export default function App() {
  const [session, dispatch] = useReducer(sessionReducer, initialSession);
  const [sources, setSources] = useState<Source[]>([]);
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [scenario, setScenario] = useState<Scenario>('supported');
  const [backend, setBackend] = useState<BackendStatus>('checking');
  // Bumped whenever the approval selection or session is invalidated so
  // in-flight transcribe/retrieve/answer responses cannot restore stale data.
  const ticketRef = useRef(0);

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
        setApproved(
          Object.fromEntries(data.sources.map((source) => [source.id, source.approved_default])),
        );
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
  // Capture and Draft stay disabled while speaking: starting a new task must
  // never strand backend speech without an interruption control.
  const speaking = session.phase === 'speaking';

  const toggleSource = useCallback(
    async (id: string) => {
      if (session.phase === 'speaking') {
        // Never strand backend speech behind a revoked approval: stop first,
        // and abort the toggle entirely when the stop fails.
        try {
          await api.stop();
        } catch (error) {
          dispatch({ type: 'stop:failed', error: errorMessage(error) });
          return;
        }
      }
      ticketRef.current += 1;
      setApproved((current) => ({ ...current, [id]: !current[id] }));
      dispatch({ type: 'sources:changed' });
    },
    [session.phase],
  );

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
    dispatch({ type: 'speak:start' });
    try {
      const speech = await api.speak(session.answer.answer_id);
      if (ticket !== ticketRef.current) {
        // Reset or invalidated while activating: release the orphaned backend
        // speech instead of restoring a session the candidate already left.
        try {
          await api.stop();
        } catch {
          // Best effort: nothing left to restore either way.
        }
        return;
      }
      dispatch({ type: 'speak:done', speech });
    } catch (error) {
      if (ticket !== ticketRef.current) {
        return;
      }
      dispatch({ type: 'fail', error: errorMessage(error) });
    }
  }, [session.answer]);

  const interrupt = useCallback(async () => {
    try {
      await api.stop();
      dispatch({ type: 'stop:done' });
    } catch (error) {
      // Stay in the speaking phase so the candidate can retry the interrupt.
      dispatch({ type: 'stop:failed', error: errorMessage(error) });
    }
  }, []);

  const reset = useCallback(async () => {
    if (session.phase === 'speaking') {
      try {
        await api.stop();
      } catch (error) {
        dispatch({ type: 'stop:failed', error: errorMessage(error) });
        return;
      }
    }
    ticketRef.current += 1;
    dispatch({ type: 'reset' });
  }, [session.phase]);

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
          {session.error}
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
              disabled={busy || backend !== 'online' || speaking}
            >
              Capture question
            </button>
            <button
              type="button"
              onClick={draft}
              disabled={session.question === '' || busy || speaking}
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
              disabled={session.answer?.status !== 'grounded'}
              onChange={(event) => {
                dispatch({ type: 'approval:set', approved: event.target.checked });
              }}
            />
            I reviewed this answer and approve it.
          </label>
          <div className="row">
            <button type="button" onClick={activate} disabled={!canActivate(session)}>
              Activate Forrest
            </button>
            <button
              type="button"
              onClick={interrupt}
              disabled={session.phase !== 'speaking'}
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
