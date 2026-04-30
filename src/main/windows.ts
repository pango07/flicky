import { app, BrowserWindow, Display, screen } from 'electron';
import path from 'path';
import type { StreamWindowBounds } from '../shared/types';

const isDev = !app.isPackaged && process.env.VITE_DEV_SERVER === '1';

function getPreloadPath(): string {
  return path.join(__dirname, '../preload/index.js');
}

function loadPage(win: BrowserWindow, page: string): void {
  if (isDev) {
    const url = `http://localhost:5173/${page}.html`;
    console.log(`[Flicky] Loading ${page} from dev server: ${url}`);
    win.loadURL(url);
  } else {
    const filePath = path.join(__dirname, '../../renderer', `${page}.html`);
    console.log(`[Flicky] Loading ${page} from file: ${filePath}`);
    win.loadFile(filePath);
  }
}

/** The main Flicky app window (settings + status). */
export function createPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 820,
    minHeight: 560,
    show: false,
    frame: true,
    titleBarStyle: 'default',
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    transparent: false,
    backgroundColor: '#0f0f11',
    title: 'Flicky',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true caused renderers to fail to render (blank screen)
      // — likely a require-resolution issue with our relative preload
      // path. Reverted; we'd need to bundle the preload as a single
      // self-contained file (esbuild) before flipping this on safely.
      sandbox: false,
    },
  });

  loadPage(win, 'panel');
  return win;
}

/**
 * Maps each overlay's webContents id back to the Display it covers, so
 * `ipcMain.handle('get-display-info')` in main/index.ts can answer the
 * renderer's request based on which window the IPC came from. Solved
 * the race where the renderer's display-info listener attaches after
 * the one-shot push has already fired.
 */
export const overlayDisplayByWebContents = new Map<number, Display>();

/** A transparent, click-through overlay covering one display. */
export function createOverlayWindow(display: Display): BrowserWindow {
  const { x, y, width, height } = display.bounds;

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Click-through: let mouse events pass to windows underneath
  win.setIgnoreMouseEvents(true, { forward: true });

  // Keep overlay above everything
  win.setAlwaysOnTop(true, 'screen-saver');

  // Visible on all workspaces / virtual desktops
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadPage(win, 'overlay');

  // Track which display this overlay covers so we can answer the
  // renderer's `get-display-info` invocation from main.
  overlayDisplayByWebContents.set(win.webContents.id, display);
  win.on('closed', () => {
    overlayDisplayByWebContents.delete(win.webContents.id);
  });

  // Push display info eagerly too — when the renderer is fast enough
  // to subscribe before this fires, it gets the info immediately and
  // can skip the invoke roundtrip on mount.
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('display-info', {
      id: display.id,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
    });
  });

  return win;
}

/**
 * The transparent, draggable "stream" window that mirrors the live Q/A
 * so the user can read, scroll, and copy. It's a frameless BrowserWindow
 * with a CSS-drag region in the header; mouse events are enabled so
 * scrolling and text selection work normally.
 */
export function createStreamWindow(
  storedBounds: StreamWindowBounds | null,
): BrowserWindow {
  const bounds = storedBounds ?? defaultStreamBounds();

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 280,
    minHeight: 180,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    title: 'Flicky Stream',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadPage(win, 'stream');
  return win;
}

function defaultStreamBounds(): StreamWindowBounds {
  const primary = screen.getPrimaryDisplay();
  const { workArea } = primary;
  const width = 380;
  const height = 320;
  // Anchor to the bottom-right corner of the primary work area with a
  // small gutter, so on first launch users can find it easily.
  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + workArea.height - height - 24,
  };
}
