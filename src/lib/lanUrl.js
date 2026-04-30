/**
 * Rewrite "localhost" / "127.0.0.1" inside an absolute URL to the
 * host the page was actually loaded from. Mirrors the logic in
 * src/config.js — needed for image URLs that live inside signed
 * nostr events (post images, etc.) and so can't be rebased on the
 * server like character avatars.
 *
 * No-op when accessed from the dev machine itself (hostname matches),
 * when the URL has no localhost in it, or when called outside a
 * browser context (SSR / tests).
 */
export function lanUrl(url) {
  if (typeof url !== 'string' || !url) return url
  if (typeof window === 'undefined') return url
  const host = window.location.hostname
  if (!host || host === 'localhost' || host === '127.0.0.1') return url
  return url.replace(/\/\/(localhost|127\.0\.0\.1)\b/g, `//${host}`)
}
