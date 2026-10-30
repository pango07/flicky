import { useState, useEffect, useRef } from 'react';
import type { LocalConnection, OllamaModelInfo, OllamaPullProgress } from '../../../shared/types';
import { VISION_MODEL_CATALOG, isVisionModel as isVision } from '../../../shared/vision-models';

function fmtSize(bytes?: number): string {
  if (!bytes) return '';
  const gb = bytes / 1_073_741_824;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1_048_576).toFixed(0)} MB`;
}

interface OllamaManageModalProps {
  conn: LocalConnection;
  onClose: () => void;
  onModelSelected: (modelId: string) => void;
}

type PullState = 'idle' | 'pulling' | 'done' | 'error';

export function OllamaManageModal({ conn, onClose, onModelSelected }: OllamaManageModalProps) {
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // Pull
  const [pullTag, setPullTag] = useState('');
  const [pullState, setPullState] = useState<PullState>('idle');
  const [pullProgress, setPullProgress] = useState<OllamaPullProgress | null>(null);
  const [pullError, setPullError] = useState('');
  const [quickPullTag, setQuickPullTag] = useState<string | null>(null);

  // Delete
  const [deleteTarget, setDeleteTarget] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Create
  const [createOpen, setCreateOpen] = useState(false);
  const [createTag, setCreateTag] = useState('');
  const [createJson, setCreateJson] = useState('{\n  "from": "llama3:8b"\n}');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const bearerToken = useRef<string | undefined>(undefined);

  const getBearer = async (): Promise<string | undefined> => {
    return bearerToken.current;
  };

  const loadModels = async () => {
    setLoading(true);
    const list = await window.flicky.getOllamaModels(conn.url, await getBearer());
    setModels(list);
    setLoading(false);
  };

  useEffect(() => { void loadModels(); }, [conn.id]);

  // Wire pull progress events
  useEffect(() => {
    const offProgress = window.flicky.onOllamaPullProgress((p) => setPullProgress(p));
    const offComplete = window.flicky.onOllamaPullComplete(({ model }) => {
      setPullState('done');
      setPullTag('');
      void loadModels();
      // Auto-select pulled model
      onModelSelected(model);
    });
    const offError = window.flicky.onOllamaPullError(({ error }) => {
      setPullState('error');
      setPullError(error);
    });
    return () => { offProgress(); offComplete(); offError(); };
  }, [conn.id]);

  const handlePull = (tag = pullTag.trim()) => {
    if (!tag || pullState === 'pulling') return;
    setPullState('pulling');
    setPullProgress(null);
    setPullError('');
    window.flicky.pullOllamaModel(conn.url, tag, undefined);
  };

  const handleQuickPull = (tag: string) => {
    setQuickPullTag(tag);
    setPullTag(tag);
    handlePull(tag);
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await window.flicky.deleteOllamaModel(conn.url, deleteTarget, undefined);
      setDeleteTarget('');
      setDeleteConfirm(false);
      if (conn.activeModelId === deleteTarget) {
        onModelSelected('');
      }
      await loadModels();
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setDeleting(false);
    }
  };

  const handleCreate = async () => {
    const tag = createTag.trim();
    if (!tag || creating) return;
    setCreating(true);
    setCreateError('');
    try {
      await window.flicky.createOllamaModel(conn.url, tag, createJson, undefined);
      setCreateTag('');
      setCreateOpen(false);
      await loadModels();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const pullPercent = pullProgress?.total
    ? Math.round(((pullProgress.completed ?? 0) / pullProgress.total) * 100)
    : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box manage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Manage Ollama</span>
          <div className="modal-header-sub">{conn.url}</div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* ── Installed models ─────────────────────────────────── */}
        <div className="modal-section">
          <div className="modal-section-title">Installed models</div>
          {loading ? (
            <div className="modal-hint">Loading…</div>
          ) : models.length === 0 ? (
            <div className="modal-hint">No models installed. Pull one below.</div>
          ) : (
            <div className="model-manage-list">
              {models.map((m) => {
                const vision = isVision(m.name);
                const active = conn.activeModelId === m.name;
                return (
                  <button
                    key={m.name}
                    className={`model-manage-item ${active ? 'on' : ''}`}
                    onClick={() => onModelSelected(active ? '' : m.name)}
                  >
                    <div className="model-radio" />
                    <div className="model-meta">
                      <div className="model-name">
                        {m.name}
                        {vision && <span className="vision-badge">vision</span>}
                      </div>
                      <div className="model-sub">{fmtSize(m.size)}</div>
                    </div>
                    {active && <div className="model-tag info">active</div>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Vision model catalog ─────────────────────────────── */}
        <div className="modal-section">
          <div className="modal-section-title">Vision-capable models</div>
          <div className="catalog-scroll">
            <div className="catalog-list">
              {VISION_MODEL_CATALOG.map((entry) => {
                const installed = models.some((m) => m.name === entry.tag);
                const isPulling = pullState === 'pulling' && quickPullTag === entry.tag;
                return (
                  <div key={entry.tag} className="catalog-item">
                    <div className="catalog-meta">
                      <div className="catalog-name">{entry.name}</div>
                      <div className="catalog-desc">{entry.description}</div>
                      <div className="catalog-size">{entry.sizeLabel}</div>
                    </div>
                    <div className="catalog-action">
                      {installed ? (
                        <span className="model-tag info">installed</span>
                      ) : (
                        <button
                          className="btn xs primary"
                          disabled={pullState === 'pulling'}
                          onClick={() => handleQuickPull(entry.tag)}
                        >
                          {isPulling ? 'Pulling…' : 'Pull'}
                        </button>
                      )}
                      <button
                        className="link-btn"
                        onClick={() => window.flicky.openExternal(`https://ollama.com/library/${entry.librarySlug}`)}
                      >
                        Browse
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {pullState === 'pulling' && quickPullTag && pullProgress && (
            <div className="pull-progress">
              <div className="pull-status">{pullProgress.status}</div>
              {pullPercent !== null && (
                <>
                  <div className="pull-bar-wrap">
                    <div className="pull-bar" style={{ width: `${pullPercent}%` }} />
                  </div>
                  <div className="pull-pct">{pullPercent}%</div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Pull a model ─────────────────────────────────────── */}
        <div className="modal-section">
          <div className="modal-section-title">Pull a model from Ollama.com</div>
          <div className="modal-input-row">
            <input
              type="text"
              className="modal-input"
              placeholder="Enter model tag (e.g. mistral:7b)"
              value={pullTag}
              onChange={(e) => { setPullTag(e.target.value); setPullState('idle'); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handlePull(); }}
              disabled={pullState === 'pulling'}
            />
            <button
              className="btn xs primary"
              onClick={() => handlePull()}
              disabled={!pullTag.trim() || pullState === 'pulling'}
            >
              {pullState === 'pulling' ? 'Pulling…' : 'Pull'}
            </button>
          </div>

          {pullState === 'pulling' && pullProgress && (
            <div className="pull-progress">
              <div className="pull-status">{pullProgress.status}</div>
              {pullPercent !== null && (
                <div className="pull-bar-wrap">
                  <div className="pull-bar" style={{ width: `${pullPercent}%` }} />
                </div>
              )}
              {pullPercent !== null && (
                <div className="pull-pct">{pullPercent}%</div>
              )}
            </div>
          )}
          {pullState === 'done' && (
            <div className="modal-hint ok">Model pulled and selected.</div>
          )}
          {pullState === 'error' && (
            <div className="modal-hint err">Error: {pullError}</div>
          )}
          <div className="modal-hint">
            To browse available models,{' '}
            <button
              className="link-btn"
              onClick={() => window.flicky.openExternal('https://ollama.com/library')}
            >
              click here
            </button>
            .
          </div>
        </div>

        {/* ── Delete a model ───────────────────────────────────── */}
        <div className="modal-section">
          <div className="modal-section-title">Delete a model</div>
          <div className="modal-input-row">
            <select
              className="modal-input modal-select"
              value={deleteTarget}
              onChange={(e) => { setDeleteTarget(e.target.value); setDeleteConfirm(false); }}
            >
              <option value="">Select a model…</option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
            {deleteTarget && !deleteConfirm && (
              <button className="btn xs danger" onClick={() => setDeleteConfirm(true)}>
                Delete
              </button>
            )}
            {deleteTarget && deleteConfirm && (
              <>
                <button
                  className="btn xs danger"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : 'Confirm'}
                </button>
                <button className="btn xs subtle" onClick={() => setDeleteConfirm(false)}>
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Create a model ───────────────────────────────────── */}
        <div className="modal-section">
          <button
            className="modal-section-toggle"
            onClick={() => setCreateOpen((x) => !x)}
          >
            <span>Create a model</span>
            <span className="chev">{createOpen ? '▴' : '▾'}</span>
          </button>

          {createOpen && (
            <>
              <div className="modal-input-row" style={{ marginTop: 10 }}>
                <input
                  type="text"
                  className="modal-input"
                  placeholder="Enter model tag (e.g. my-modelfile)"
                  value={createTag}
                  onChange={(e) => setCreateTag(e.target.value)}
                />
              </div>
              <textarea
                className="modal-textarea"
                rows={4}
                value={createJson}
                onChange={(e) => setCreateJson(e.target.value)}
                placeholder='e.g. {"model": "my-modelfile", "from": "llama3:8b"}'
                spellCheck={false}
              />
              {createError && <div className="modal-hint err">{createError}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <button
                  className="btn xs primary"
                  onClick={handleCreate}
                  disabled={!createTag.trim() || creating}
                >
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
          <button className="btn xs subtle" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
