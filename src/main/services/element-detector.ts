import type { ScreenCapture, DetectedElement, Walkthrough, WalkthroughStep } from '../../shared/types';

/** Regex used to find every [TYPE:...] tag in a model response. */
const TYPE_TAG_REGEX = /\[TYPE:((?:[^\]\\]|\\.)+)\]/g;

/** Regex that matches both POINT and TYPE tags, used to strip them
 *  from text we feed to TTS / chat history / display. */
export const TAG_STRIP_REGEX = /\[(?:POINT|TYPE):[^\]]+\]/g;

/**
 * Parse [TYPE:text] tags. Backslashes inside the text escape the next
 * character (so the model can include a literal `]` if it must), e.g.
 * [TYPE:hello\] world] → "hello] world".
 */
export function parseTypeTags(responseText: string): string[] {
  TYPE_TAG_REGEX.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = TYPE_TAG_REGEX.exec(responseText)) !== null) {
    out.push(m[1].replace(/\\(.)/g, '$1'));
  }
  return out;
}

/**
 * Parse [POINT:x,y:label:screenN] tags from an LLM response.
 *
 * - parsePointTags: returns the first match (legacy single-point flow).
 * - parseAllPointTags: returns every match in the order it appeared, so
 *   multi-step walkthroughs can be reconstructed from the response.
 *
 * Pixel coordinates inside the screenshot are mapped back to the
 * corresponding display's logical coordinate space using each capture's
 * recorded bounds, so points line up regardless of display scaling.
 */

const POINT_TAG_REGEX = /\[POINT:(\d+),(\d+):([^:]+):screen(\d+)\]/g;

function pointToElement(
  match: RegExpExecArray,
  screenshots: ScreenCapture[],
): DetectedElement | null {
  const pixelX = parseInt(match[1], 10);
  const pixelY = parseInt(match[2], 10);
  const label = match[3];
  const screenIndex = parseInt(match[4], 10);

  const screenshot = screenshots[screenIndex];
  if (!screenshot) return null;

  const scaleX = screenshot.displayBounds.width / screenshot.imageWidth;
  const scaleY = screenshot.displayBounds.height / screenshot.imageHeight;

  return {
    x: screenshot.displayBounds.x + pixelX * scaleX,
    y: screenshot.displayBounds.y + pixelY * scaleY,
    label,
    screenIndex,
  };
}

export function parsePointTags(
  responseText: string,
  screenshots: ScreenCapture[],
): DetectedElement | null {
  POINT_TAG_REGEX.lastIndex = 0;
  const match = POINT_TAG_REGEX.exec(responseText);
  if (!match) return null;
  return pointToElement(match, screenshots);
}

export function parseAllPointTags(
  responseText: string,
  screenshots: ScreenCapture[],
): Walkthrough | null {
  POINT_TAG_REGEX.lastIndex = 0;
  const elements: DetectedElement[] = [];
  let match: RegExpExecArray | null;
  while ((match = POINT_TAG_REGEX.exec(responseText)) !== null) {
    const el = pointToElement(match, screenshots);
    if (el) elements.push(el);
  }
  if (elements.length === 0) return null;

  const total = elements.length;
  const steps: WalkthroughStep[] = elements.map((el, i) => ({
    ...el,
    step: i + 1,
    total,
  }));
  return { steps };
}
