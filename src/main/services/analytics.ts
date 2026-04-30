import { app } from 'electron';
import type { PostHog } from 'posthog-node';

// posthog-node pulls a chunky transitive tree (axios / undici-ish bits).
// Importing it eagerly added measurable cold-start latency in packaged
// builds even though the default key is empty and analytics are off.
// Lazy-import inside initAnalytics so the module only hits the JIT when
// a real key is supplied.

let client: PostHog | null = null;
let distinctId = 'anonymous';

export function initAnalytics(apiKey: string, host: string): void {
  if (!apiKey) return;
  void import('posthog-node').then(({ PostHog }) => {
    client = new PostHog(apiKey, { host });
    distinctId = `flicky-${Date.now()}`;
  }).catch((err) => {
    console.error('[Flicky] analytics init failed:', err);
  });
}

function capture(event: string, properties?: Record<string, unknown>): void {
  client?.capture({
    distinctId,
    event,
    properties: {
      ...properties,
      app_version: app.getVersion(),
      platform: process.platform,
    },
  });
}

// ── App Lifecycle ──────────────────────────────────────────────────────

export const trackAppOpened = () => capture('app_opened');

// ── Onboarding ─────────────────────────────────────────────────────────

export const trackOnboardingStarted = () => capture('onboarding_started');
export const trackOnboardingReplayed = () => capture('onboarding_replayed');
export const trackOnboardingVideoCompleted = () => capture('onboarding_video_completed');
export const trackOnboardingDemoTriggered = () => capture('onboarding_demo_triggered');

// ── Permissions ────────────────────────────────────────────────────────

export const trackAllPermissionsGranted = () => capture('all_permissions_granted');
export const trackPermissionGranted = (permission: string) =>
  capture('permission_granted', { permission });

// ── Voice Interactions ─────────────────────────────────────────────────

export const trackPushToTalkStarted = () => capture('push_to_talk_started');
export const trackPushToTalkReleased = () => capture('push_to_talk_released');
export const trackUserMessageSent = (transcript: string) =>
  capture('user_message_sent', { transcript, char_count: transcript.length });
export const trackAiResponseReceived = (response: string) =>
  capture('ai_response_received', { response, char_count: response.length });
export const trackElementPointed = (label: string) =>
  capture('element_pointed', { element_label: label });

// ── Errors ─────────────────────────────────────────────────────────────

export const trackResponseError = (error: string) =>
  capture('response_error', { error_message: error });
export const trackTtsError = (error: string) =>
  capture('tts_error', { error_message: error });

// ── Shutdown ───────────────────────────────────────────────────────────

export async function shutdownAnalytics(): Promise<void> {
  await client?.shutdown();
}
