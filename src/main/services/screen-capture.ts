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
  const { cursorOnly = true } = opts;
  const allDisplays = screen.getAllDisplays();
  const cursorPoint = screen.getCursorScreenPoint();
  const displays = cursorOnly
    ? allDisplays.filter((d) => {
        const b = d.bounds;
        return (
          cursorPoint.x >= b.x &&
          cursorPoint.x < b.x + b.width &&
          cursorPoint.y >= b.y &&
          cursorPoint.y < b.y + b.height
        );
      })
    : allDisplays;

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

    if (!source) continue;

    const thumbnail = source.thumbnail;
    // When Screen Recording permission is missing on macOS, desktopCapturer
    // silently returns sources whose thumbnail is empty (size 0×0) rather
    // than throwing. Skip those so we don't ship an empty base64 image to
    // the LLM and trigger a 400.
    if (thumbnail.isEmpty()) continue;
    const size = thumbnail.getSize();
    if (size.width === 0 || size.height === 0) continue;

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

  return captures;
}

/**
 * Backwards-compatible alias for code that still imports the old name.
 * New callers should use captureDisplays() with explicit options.
 */
export const captureAllDisplays = (): Promise<ScreenCapture[]> =>
  captureDisplays({ cursorOnly: true });
