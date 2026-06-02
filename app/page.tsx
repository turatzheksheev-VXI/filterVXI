'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import Papa from 'papaparse';

// ─── Types ────────────────────────────────────────────────────────────────────

type Decision = 'KEEP' | 'DROP' | 'REVIEW' | 'ERROR';
type Row = Record<string, string>;
type ScoredRow = Row & { Decision: Decision; Reason: string };
type Phase = 'idle' | 'running' | 'paused' | 'done' | 'stopped';

// ─── Constants ────────────────────────────────────────────────────────────────

const FIELDS = ['First Name', 'Last Name', 'Company Name', 'Job Title', 'Seniority', 'Job Function'];
const DELAY_MS = 2150;

const BADGE: Record<Decision, string> = {
  KEEP:   'bg-green-950 text-green-400 border border-green-900/50',
  DROP:   'bg-red-950 text-red-400 border border-red-900/50',
  REVIEW: 'bg-yellow-950 text-yellow-400 border border-yellow-900/50',
  ERROR:  'bg-gray-800 text-gray-500 border border-gray-700',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function callGroq(row: Row): Promise<{ decision: Decision; reason: string }> {
  const contactText = FIELDS
    .filter(f => row[f]?.trim())
    .map(f => `${f}: ${row[f]}`)
    .join('\n');

  const res = await fetch('/api/groq', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactText }),
  });

  if (!res.ok) {
    if (res.status === 429) throw new Error('rate_limit');
    const body = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${body.slice(0, 80)}`);
  }

  const data = await res.json();
  const text: string = data.choices[0].message.content.trim();

  let decision: Decision = 'ERROR';
  let reason = 'Could not parse';

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.toUpperCase().startsWith('DECISION:')) {
      const raw = t.split(':', 2)[1].trim().toUpperCase();
      decision = (['KEEP', 'DROP', 'REVIEW'] as string[]).includes(raw)
        ? (raw as Decision)
        : 'REVIEW';
    } else if (t.toUpperCase().startsWith('REASON:')) {
      reason = t.split(':', 2)[1].trim();
    }
  }

  return { decision, reason };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Home() {
  const [rows, setRows]       = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [results, setResults] = useState<(ScoredRow | null)[]>([]);
  const [current, setCurrent] = useState(0);
  const [phase, setPhase]     = useState<Phase>('idle');
  const [filter, setFilter]   = useState<'ALL' | Decision>('ALL');
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState('');

  const stopRef    = useRef(false);
  const pauseRef   = useRef(false);
  const currentRef = useRef(0);

  const stats = useMemo(() => {
    const scored = results.filter(Boolean) as ScoredRow[];
    return {
      keep:   scored.filter(r => r.Decision === 'KEEP').length,
      drop:   scored.filter(r => r.Decision === 'DROP').length,
      review: scored.filter(r => r.Decision === 'REVIEW').length,
      total:  scored.length,
    };
  }, [results]);

  const filtered = useMemo(
    () => (results.filter(Boolean) as ScoredRow[]).filter(r => filter === 'ALL' || r.Decision === filter),
    [results, filter],
  );

  const processFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) { alert('Please upload a .csv file.'); return; }
    setFileName(file.name);
    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data, meta }) => {
        setRows(data);
        setColumns(meta.fields ?? []);
        setResults(new Array(data.length).fill(null));
        setCurrent(0);
        currentRef.current = 0;
        setPhase('idle');
      },
      error: err => alert('Parse error: ' + err.message),
    });
  }, []);

  const startScoring = useCallback(async () => {
    if (!rows.length) return;
    stopRef.current  = false;
    pauseRef.current = false;
    setPhase('running');

    while (currentRef.current < rows.length && !stopRef.current) {
      while (pauseRef.current && !stopRef.current) await sleep(300);
      if (stopRef.current) break;

      const idx = currentRef.current;
      const row = rows[idx];
      let decision: Decision = 'ERROR';
      let reason = 'Failed';
      let retries = 3;
      let backoff = 30000;
      let scored = false;

      while (retries > 0 && !scored) {
        try {
          const r = await callGroq(row);
          decision = r.decision;
          reason   = r.reason;
          scored   = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === 'rate_limit') {
            await sleep(backoff);
            backoff = Math.min(backoff * 2, 120_000);
            retries--;
          } else {
            reason = msg.slice(0, 60);
            scored = true;
          }
        }
      }
      if (!scored) reason = 'Max retries exceeded';

      setResults(prev => {
        const next = [...prev];
        next[idx] = { ...row, Decision: decision, Reason: reason };
        return next;
      });
      currentRef.current = idx + 1;
      setCurrent(idx + 1);

      if (currentRef.current < rows.length && !stopRef.current) await sleep(DELAY_MS);
    }

    setPhase(currentRef.current >= rows.length ? 'done' : 'stopped');
  }, [rows]);

  const togglePause = () => {
    pauseRef.current = !pauseRef.current;
    setPhase(prev => (prev === 'paused' ? 'running' : 'paused'));
  };

  const stopScoring = () => { stopRef.current = true; pauseRef.current = false; };

  const downloadCSV = () => {
    const scored = results.filter(Boolean) as ScoredRow[];
    if (!scored.length) { alert('No results yet.'); return; }
    const csv = Papa.unparse(scored);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `vxi_scored_${new Date().toISOString().slice(0, 10)}.csv`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const pct       = rows.length ? Math.round((current / rows.length) * 100) : 0;
  const remaining = rows.length - current;
  const eta       = remaining > 0 ? `~${(remaining * DELAY_MS / 60_000).toFixed(1)} min remaining` : '';

  const statusLabel: Record<Phase, string> = {
    idle:    'Ready to score',
    running: `Scoring… ${current} / ${rows.length} (${pct}%)`,
    paused:  `Paused at ${current} / ${rows.length}`,
    done:    'Scoring complete!',
    stopped: `Stopped at ${current} / ${rows.length}`,
  };

  return (
    <main className="bg-gray-950 text-gray-100 min-h-screen antialiased">
      <div className="max-w-5xl mx-auto px-4 py-10 pb-20">

        {/* Header */}
        <header className="mb-10">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center font-bold text-xs tracking-tight select-none">
              VXI
            </div>
            <span className="text-gray-500 text-sm">BDM Outreach Tooling</span>
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Contact Scorer</h1>
          <p className="text-gray-400 mt-2 text-sm leading-relaxed max-w-2xl">
            Upload a 6sense CSV export and score every contact for VXI outreach using Groq&apos;s Llama 3.3 70B.
            Each contact is classified as{' '}
            <span className="text-green-400 font-medium">KEEP</span>,{' '}
            <span className="text-red-400 font-medium">DROP</span>, or{' '}
            <span className="text-yellow-400 font-medium">REVIEW</span> — with a reason.
          </p>
        </header>

        {/* Upload */}
        <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-4">
          <h2 className="font-semibold text-white mb-1">Upload 6sense CSV</h2>
          <p className="text-gray-500 text-sm mb-4">
            Expects columns:{' '}
            <span className="font-mono text-gray-400 text-xs">{FIELDS.join(', ')}</span>
          </p>
          <div
            className={`drop-zone rounded-xl p-10 text-center cursor-pointer hover:border-gray-500 transition-colors ${dragOver ? 'dragover' : ''}`}
            onClick={() => document.getElementById('fileInput')?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
          >
            <div className="text-3xl mb-2 select-none">📄</div>
            <p className="text-gray-300 font-medium text-sm">
              Drop CSV here or <span className="text-blue-400">browse</span>
            </p>
            <p className="text-gray-600 text-xs mt-1">Only .csv files</p>
            <input id="fileInput" type="file" accept=".csv" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f); }} />
          </div>
          {fileName && (
            <div className="mt-3 flex items-center gap-3 px-4 py-3 bg-gray-800 rounded-xl">
              <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="text-sm text-gray-300 font-medium truncate">{fileName}</span>
              <span className="text-xs text-gray-500 ml-auto shrink-0">{rows.length} rows</span>
            </div>
          )}
        </section>

        {/* Column detection */}
        {columns.length > 0 && (
          <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-4">
            <h2 className="font-semibold text-white mb-3 text-sm">Column Detection</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              {FIELDS.map(f => {
                const found = columns.includes(f);
                return (
                  <div key={f} className={`flex items-center gap-1.5 px-3 py-2 rounded-lg ${found ? 'bg-green-950/60 border border-green-900/40 text-green-400' : 'bg-red-950/60 border border-red-900/40 text-red-400'}`}>
                    <span>{found ? '✓' : '✗'}</span>
                    <span className="font-mono truncate">{f}</span>
                    {!found && <span className="ml-auto text-red-600 shrink-0">missing</span>}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Preview */}
        {rows.length > 0 && (
          <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-4">
            <h2 className="font-semibold text-white mb-3 text-sm">
              Preview <span className="text-gray-600 font-normal">(first 5 rows)</span>
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-gray-400">
                <thead>
                  <tr className="border-b border-gray-800">
                    {columns.slice(0, 7).map(c => (
                      <th key={c} className="text-left pb-2 pr-4 text-gray-600 font-medium whitespace-nowrap">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((row, i) => (
                    <tr key={i} className="border-b border-gray-800/40">
                      {columns.slice(0, 7).map(c => (
                        <td key={c} className="py-1.5 pr-4 max-w-[160px] truncate" title={row[c] ?? ''}>{row[c] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Controls */}
        {rows.length > 0 && (
          <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-4">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <p className="text-sm text-gray-300 font-medium">{statusLabel[phase]}</p>
                {phase === 'running' && <p className="text-xs text-gray-600 mt-0.5">{eta}</p>}
              </div>
              <div className="flex gap-2 shrink-0">
                {phase !== 'running' && phase !== 'paused' && (
                  <button onClick={startScoring} disabled={phase === 'done'}
                    className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-sm font-medium transition-colors">
                    {phase === 'done' ? 'Done ✓' : phase === 'stopped' ? 'Resume' : 'Start Scoring'}
                  </button>
                )}
                {(phase === 'running' || phase === 'paused') && (
                  <>
                    <button onClick={togglePause}
                      className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-xl text-sm transition-colors">
                      {phase === 'paused' ? 'Resume' : 'Pause'}
                    </button>
                    <button onClick={stopScoring}
                      className="px-4 py-2 bg-red-950 hover:bg-red-900 text-red-400 rounded-xl text-sm transition-colors">
                      Stop
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="bg-gray-800 rounded-full h-1.5 overflow-hidden">
              <div className="bg-blue-500 h-full rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
          </section>
        )}

        {/* Stats */}
        {rows.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {([
              { label: 'Keep',   value: stats.keep,   color: 'text-green-400'  },
              { label: 'Drop',   value: stats.drop,   color: 'text-red-400'    },
              { label: 'Review', value: stats.review, color: 'text-yellow-400' },
              { label: 'Scored', value: stats.total,  color: 'text-gray-400'   },
            ] as const).map(({ label, value, color }) => (
              <div key={label} className="bg-gray-900 border border-gray-800 rounded-2xl p-4 text-center">
                <p className={`text-2xl font-bold ${color}`}>{value}</p>
                <p className="text-xs text-gray-600 mt-1 uppercase tracking-wide">{label}</p>
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {rows.length > 0 && (
          <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="font-semibold text-white text-sm">Results</h2>
              <div className="flex items-center gap-2">
                <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-blue-500">
                  <option value="ALL">All decisions</option>
                  <option value="KEEP">KEEP only</option>
                  <option value="REVIEW">REVIEW only</option>
                  <option value="DROP">DROP only</option>
                  <option value="ERROR">Errors</option>
                </select>
                <button onClick={downloadCSV}
                  className="px-4 py-1.5 bg-green-800 hover:bg-green-700 text-green-200 rounded-lg text-xs font-medium transition-colors">
                  Download CSV
                </button>
              </div>
            </div>

            {/* Sticky header + scrollable body */}
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left border-b border-gray-800">
                    {['Name', 'Company', 'Title', 'Decision', 'Reason'].map(h => (
                      <th key={h} className="pb-2.5 pr-4 text-xs text-gray-600 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
              </table>
              <div className="overflow-y-auto" style={{ maxHeight: '420px' }}>
                <table className="w-full">
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center text-gray-600 text-sm py-10">
                          {results.filter(Boolean).length === 0 ? 'Results will appear here as contacts are scored.' : 'No results match the filter.'}
                        </td>
                      </tr>
                    ) : filtered.map((r, i) => {
                      const name = [r['First Name'], r['Last Name']].filter(Boolean).join(' ') || '—';
                      return (
                        <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/20 fade-in">
                          <td className="py-2.5 pr-4 text-gray-200 font-medium text-sm whitespace-nowrap">{name}</td>
                          <td className="py-2.5 pr-4 text-gray-400 text-sm max-w-[150px] truncate" title={r['Company Name']}>{r['Company Name'] || '—'}</td>
                          <td className="py-2.5 pr-4 text-gray-400 text-sm max-w-[200px] truncate" title={r['Job Title']}>{r['Job Title'] || '—'}</td>
                          <td className="py-2.5 pr-4">
                            <span className={`px-2 py-0.5 rounded-md text-xs font-semibold ${BADGE[r.Decision]}`}>{r.Decision}</span>
                          </td>
                          <td className="py-2.5 text-gray-500 text-xs">{r.Reason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

      </div>
    </main>
  );
}
