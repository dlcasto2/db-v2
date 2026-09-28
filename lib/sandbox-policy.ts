/**
 * What a proxied page may do, ported from the sandbox profiles WebKit runs its
 * web-content processes under (com.apple.WebProcess.sb, GPUProcess.sb):
 * pages get no camera, microphone, location, USB/serial/HID/Bluetooth devices,
 * clipboard reads, payments or screen capture.
 *
 * This matters more in Devon than in a normal browser: every proxied site
 * runs on Devon's own origin, so a permission granted to one site (say, the
 * microphone) would silently apply to every other site opened in Devon.
 *
 * Playback features (fullscreen, autoplay, picture-in-picture, DRM) and
 * clipboard writes stay allowed. Remove a name from this list to allow it again.
 */
export const BLOCKED_PAGE_FEATURES = [
  "camera",
  "microphone",
  "geolocation",
  "display-capture",
  "clipboard-read",
  "usb",
  "serial",
  "hid",
  "bluetooth",
  "midi",
  "payment",
  "publickey-credentials-get",
  "idle-detection",
  "local-fonts",
  "window-management",
  "xr-spatial-tracking",
  "accelerometer",
  "gyroscope",
  "magnetometer",
] as const

/** For the proxied page's <iframe allow="…"> */
export const FRAME_ALLOW = BLOCKED_PAGE_FEATURES.map((f) => `${f} 'none'`).join("; ")

/** Permissions-Policy header value for proxied HTML responses */
export const PERMISSIONS_POLICY = BLOCKED_PAGE_FEATURES.map((f) => `${f}=()`).join(", ")

/**
 * Content types a browser renders as a document that can run script. The
 * proxy's raw and file responses are only meant to be fetched or displayed,
 * so these get `Content-Security-Policy: sandbox`: opening such a URL
 * directly (e.g. a crafted /api/proxy?url=…&raw=1 link) can't run script on
 * Devon's origin. It has no effect on fetch()/XHR, images or media.
 */
export const DOCUMENT_TYPE_RE = /html|xml|svg/i

export const SANDBOX_CSP = "sandbox"
