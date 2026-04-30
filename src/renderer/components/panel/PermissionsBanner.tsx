import { useEffect, useState } from 'react';
import type { FlickySettings } from '../../../shared/types';

type Perms = Record<string, boolean>;

interface Row {
  kind: 'microphone' | 'screen' | 'accessibility';
  label: string;
  reason: string;
  /** Settings-derived gate — only shown when this returns true. */
  visibleWhen?: (s: FlickySettings | null) => boolean;
}

const ROWS: Row[] = [
  {
    kind: 'microphone',
    label: 'Microphone',
    reason: 'so Flicky can hear you when you push to talk',
  },
  {
    kind: 'screen',
    label: 'Screen Recording',
    reason: 'so Flicky can see your screen and point at things',
  },
  {
    kind: 'accessibility',
    label: 'Accessibility',
    reason: 'so Flicky can type into the focused field for you',
    // Only nag the user about this one when they've actually turned
    // on auto-typing. Keeps the banner quiet for users who never
    // care about that feature.
    visibleWhen: (s) => !!s?.autoTypeEnabled,
  },
];

export function PermissionsBanner() {
  const [perms, setPerms] = useState<Perms | null>(null);
  const [settings, setSettings] = useState<FlickySettings | null>(null);

  useEffect(() => {
    if (process.platform !== 'darwin') return;
    window.flicky.getPermissions().then(setPerms);
    window.flicky.getSettings().then(setSettings);
    const unsubPerms = window.flicky.onPermissionStatus(setPerms);
    const unsubSettings = window.flicky.onSettingsChanged(setSettings);
    return () => {
      unsubPerms();
      unsubSettings();
    };
  }, []);

  if (process.platform !== 'darwin') return null;
  if (!perms) return null;

  const missing = ROWS.filter((r) => {
    if (perms[r.kind]) return false;
    if (r.visibleWhen && !r.visibleWhen(settings)) return false;
    return true;
  });
  if (missing.length === 0) return null;

  return (
    <div className="perm-banner">
      <div className="perm-banner-head">
        <span className="perm-banner-title">Flicky needs a few permissions</span>
        <span className="perm-banner-sub">
          macOS controls access per-app. Without these, Flicky can&apos;t hear you, see your screen, or type for you.
        </span>
      </div>
      <div className="perm-banner-rows">
        {missing.map((r) => (
          <div className="perm-banner-row" key={r.kind}>
            <div className="perm-banner-text">
              <span className="perm-banner-label">{r.label}</span>
              <span className="perm-banner-reason">{r.reason}</span>
            </div>
            <button
              className="perm-banner-btn"
              onClick={() => window.flicky.requestPermission(r.kind)}
            >
              Grant
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
