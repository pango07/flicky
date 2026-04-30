import { systemPreferences } from 'electron';

/**
 * Native auto-typer wrapper. The underlying module (`@nut-tree-fork/nut-js`)
 * ships native bindings for libnut and emits global keyboard events through
 * the OS. We load it lazily so a failed install doesn't crash the main
 * process — every consumer goes through `typeText`, which returns `false`
 * if the module or the required permission is unavailable, and the caller
 * falls back to clipboard handoff.
 */

type NutJs = typeof import('@nut-tree-fork/nut-js');

let nutJs: NutJs | null = null;
let loadAttempted = false;

async function load(): Promise<NutJs | null> {
  if (loadAttempted) return nutJs;
  loadAttempted = true;
  try {
    nutJs = await import('@nut-tree-fork/nut-js');
  } catch (err) {
    console.error('[Flicky] auto-typer native module unavailable:', err);
    nutJs = null;
  }
  return nutJs;
}

/**
 * Whether the OS permission required for auto-typing is currently granted.
 * On macOS this is Accessibility (Input Monitoring is not enough — typing
 * keystrokes globally requires the Accessibility trust list). On other
 * platforms there is no equivalent gate.
 */
export function isAccessibilityGranted(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(false);
}

/**
 * Surface the macOS Accessibility prompt and add Flicky to the trust
 * list. The user still has to enable the checkbox themselves; the OS
 * does not return a granted state until they do, but the dialog gives
 * them the discovery path.
 */
export function promptAccessibility(): boolean {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(true);
}

/**
 * Type `text` into whatever the OS considers the focused element.
 * Returns true when the keys were sent successfully, false when the
 * caller should fall back to clipboard handoff (module missing,
 * permission missing, or libnut threw).
 */
export async function typeText(text: string): Promise<boolean> {
  if (!text) return false;
  const lib = await load();
  if (!lib) return false;
  if (!isAccessibilityGranted()) return false;
  try {
    // Default delay is fine for native apps; web inputs sometimes drop
    // characters at zero delay, but raising this hurts the "magical"
    // feel. If we see drops in practice we can bump to ~5–10ms.
    lib.keyboard.config.autoDelayMs = 0;
    await lib.keyboard.type(text);
    return true;
  } catch (err) {
    console.error('[Flicky] auto-type failed:', err);
    return false;
  }
}
