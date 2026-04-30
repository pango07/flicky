import type { FlickyAPI } from '../preload/index';

declare global {
  interface Window {
    flicky: FlickyAPI;
  }
}

