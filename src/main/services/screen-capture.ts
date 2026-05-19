import { desktopCapturer, screen } from 'electron';
import type { ScreenCapture } from '../../shared/types';

// Bumped from 1280 → 1600. Higher res = more pixel precision when the
// model reports POINT coordinates, at the cost of ~50% more image tokens
// per turn. With cursor-only capture this stays well under the per-image
// limits for both Anthropic and OpenAI vision models.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 82;

/**
 * Capture displays as JPEG screenshots with metadata.
 *
 * @param opts.cursorOnly - if true, return only the display the user's
 *   cursor is currently on. Saves tokens and avoids confusing the model
 *   with screens the user isn't actively looking at. Default true.
 */
export async function captureDisplays(
  opts: { cursorOnly?: boolean } = {},
): Promise<ScreenCapture[]> {
  const first = await captureOnce(opts);
  if (first.length > 0) return first;
  // On macOS, desktopCapturer's source thumbnails can be empty on the
  // very first call shortly after app launch — the capture pipeline
  // hasn't warmed up yet. A single short-delayed retry reliably hands
  // back populated thumbnails without bothering the user.
  console.warn('[Flicky] capture returned zero on first try; retrying after 300ms');
  await new Promise((r) => setTimeout(r, 300));
  return captureOnce(opts);
}

async function captureOnce(
  opts: { cursorOnly?: boolean } = {},
): Promise<ScreenCapture[]> {
  const { cursorOnly = true } = opts;
  const allDisplays = screen.getAllDisplays();
  const cursorPoint = screen.getCursorScreenPoint();
  let displays = allDisplays;
  if (cursorOnly) {
    const onCursor = allDisplays.filter((d) => {
      const b = d.bounds;
      return (
        cursorPoint.x >= b.x &&
        cursorPoint.x < b.x + b.width &&
        cursorPoint.y >= b.y &&
        cursorPoint.y < b.y + b.height
      );
    });
    // Fall back to all displays if the cursor-only filter excludes
    // everything (which can happen if the cursor is mid-transition,
    // the OS returned a stale point right after a resolution change,
    // or there's a multi-monitor topology we don't recognize). Better
    // to send the model a screenshot of *some* screen than to bail
    // and tell the user we can't see their screen at all.
    if (onCursor.length > 0) {
      displays = onCursor;
    } else {
      console.warn(
        '[Flicky] cursor-only filter excluded every display ' +
        `(cursor at ${cursorPoint.x},${cursorPoint.y}, ` +
        `displays: ${allDisplays.map((d) => `${d.id}@${JSON.stringify(d.bounds)}`).join(' ')}). ` +
        'Falling back to all displays.',
      );
    }
  }

  // Get all screen sources
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: MAX_DIMENSION, height: MAX_DIMENSION },
  });

  const captures: ScreenCapture[] = [];

  for (const display of displays) {
    // Match source to display
    const source = sources.find((s) => {
      // Electron display ids and source display_id should match
      return s.display_id === String(display.id);
    }) ?? sources[captures.length]; // Fallback to index-based matching

    if (!source) {
      console.warn(`[Flicky] no source matched display ${display.id}`);
      continue;
    }

    const thumbnail = source.thumbnail;
    const size = thumbnail.getSize();

    // On Windows/Linux with display scaling, the thumbnail is in physical
    // pixels but display.bounds is in logical pixels. We need to produce an
    // image whose pixel dimensions map 1:1 to the logical display bounds so
    // that Claude's pixel coordinates translate directly to OS coordinates.
    const scaleFactor = display.scaleFactor || 1;
    const logicalWidth = display.bounds.width;
    const logicalHeight = display.bounds.height;

    // Scale to fit MAX_DIMENSION while preserving aspect ratio
    let targetWidth = logicalWidth;
    let targetHeight = logicalHeight;
    const longest = Math.max(targetWidth, targetHeight);
    if (longest > MAX_DIMENSION) {
      const scale = MAX_DIMENSION / longest;
      targetWidth = Math.round(targetWidth * scale);
      targetHeight = Math.round(targetHeight * scale);
    }

    const resized = thumbnail.resize({ width: targetWidth, height: targetHeight });
    const jpegBuffer = resized.toJPEG(JPEG_QUALITY);
    // Guard only against the case that actually causes Anthropic 400s:
    // a zero-byte JPEG. Earlier broader checks (`isEmpty()`, `size===0`)
    // were rejecting valid thumbnails on some macOS configurations.
    if (jpegBuffer.length === 0) {
      console.warn(
        `[Flicky] display ${display.id}: JPEG encoded to 0 bytes ` +
        `(thumbSize=${size.width}x${size.height}, target=${targetWidth}x${targetHeight}, ` +
        `scaleFactor=${scaleFactor}); skipping`,
      );
      continue;
    }

    // Determine if cursor is on this display
    const bounds = display.bounds;
    const isCursorScreen =
      cursorPoint.x >= bounds.x &&
      cursorPoint.x < bounds.x + bounds.width &&
      cursorPoint.y >= bounds.y &&
      cursorPoint.y < bounds.y + bounds.height;

    captures.push({
      dataBase64: jpegBuffer.toString('base64'),
      displayId: display.id,
      imageWidth: targetWidth,
      imageHeight: targetHeight,
      displayBounds: bounds,
      isCursorScreen,
    });
  }

  // Sort so cursor screen is first (primary focus)
  captures.sort((a, b) => (b.isCursorScreen ? 1 : 0) - (a.isCursorScreen ? 1 : 0));

  if (captures.length === 0) {
    console.warn(
      '[Flicky] captureDisplays produced zero screenshots. ' +
      `displays=${displays.length}, sources=${sources.length}, ` +
      `sourceIds=[${sources.map((s) => s.display_id || '""').join(',')}], ` +
      `displayIds=[${displays.map((d) => d.id).join(',')}]`,
    );
  }

  return captures;
}

/**
 * Backwards-compatible alias for code that still imports the old name.
 * New callers should use captureDisplays() with explicit options.
 */
export const captureAllDisplays = (): Promise<ScreenCapture[]> =>
  captureDisplays({ cursorOnly: true });
