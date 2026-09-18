import devices from './splash-devices.json'

/**
 * iOS launch images (docs/05 §2).
 *
 * iOS ignores the web app manifest's `background_color` and shows a white flash
 * — or, worse, a blank screen — while a home-screen app boots, unless it is
 * given a launch image that matches the device's exact dimensions. There is no
 * fallback and no scaling: a wrong size is simply not used.
 *
 * Portrait only, because the manifest pins the app to portrait. The list is
 * shared with `scripts/generate-icons.mjs`, which renders the PNGs, so the
 * metadata and the files on disk cannot drift.
 */
export type SplashDevice = {
  name: string
  width: number
  height: number
  cssWidth: number
  cssHeight: number
  dpr: number
}

export const SPLASH_DEVICES: SplashDevice[] = devices

export const startupImages = SPLASH_DEVICES.map((device) => ({
  url: `/icons/splash/${device.name}.png`,
  media:
    `(device-width: ${device.cssWidth}px) and (device-height: ${device.cssHeight}px) ` +
    `and (-webkit-device-pixel-ratio: ${device.dpr}) and (orientation: portrait)`,
}))
