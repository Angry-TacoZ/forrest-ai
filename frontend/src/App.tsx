import { useCallback, useEffect, useReducer, useState } from 'react';
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

  const toggleSource = useCallback((id: string) => {
    setApproved((current) => ({ ...current, [id]: !current[id] }));
  }, []);

  const capture = useCallback(async () => {
    dispatch({ type: 'capture:start', scenario });
    try {
      const transcript = await api.transcribe(scenario);
      dispatch({ type: 'capture:done', question: transcript.question });
    } catch (error) {
      dispatch({ type: 'fail', error: errorMessage(error) });
    }
  }, [scenario]);

  const draft = useCallback(async () => {
    dispatch({ type: 'draft:start' });
    try {
      const found = await api.retrieve(session.question, approvedIds);
      dispatch({
        type: 'draft:evidence',
        evidence: found.evidence,
        searchedSources: found.searched_sources,
      });
      const answer = await api.answer(session.question, found.evidence);
      dispatch({ type: 'draft:done', answer });
    } catch (error) {
      dispatch({ type: 'fail', error: errorMessage(error) });
    }
  }, [session.question, approvedIds]);

  const activate = useCallback(async () => {
    if (!session.answer) {
      return;
    }
    dispatch({ type: 'speak:start' });
    try {
      const speech = await api.speak(session.answer.answer_id);
      dispatch({ type: 'speak:done', speech });
    } catch (error) {
      dispatch({ type: 'fail', error: errorMessage(error) });
    }
  }, [session.answer]);

  const interrupt = useCallback(async () => {
    try {
      await api.stop();
      dispatch({ type: 'stop:done' });
    } catch (error) {
      dispatch({ type: 'fail', error: errorMessage(error) });
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
                    toggleSource(source.id);
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
            <button type="button" onClick={capture} disabled={busy || backend !== 'online'}>
              Capture question
            </button>
            <button type="button" onClick={draft} disabled={session.question === '' || busy}>
              Draft answer
            </button>
            <button
              type="button"
              onClick={() => {
                dispatch({ type: 'reset' });
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
