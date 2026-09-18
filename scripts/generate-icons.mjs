/**
 * Renders the brand mark into the PNG sizes a PWA actually needs.
 * Run with `pnpm icons` after changing public/brand/icon.svg.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import sharp from 'sharp'
import devices from '../src/lib/splash-devices.json' with { type: 'json' }

const SRC = 'public/brand/icon.svg'
const OUT = 'public/icons'
const SPLASH = 'public/icons/splash'

// A maskable icon is cropped to a circle on some launchers, so the artwork has
// to sit inside the middle 80%. We scale the mark down and pad with brand navy.
const MASKABLE_SAFE_RATIO = 0.78

const svg = await readFile(SRC)
await mkdir(OUT, { recursive: true })

const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon-32.png', size: 32 },
  { name: 'favicon-16.png', size: 16 },
]

for (const { name, size } of targets) {
  await sharp(svg, { density: 512 }).resize(size, size).png().toFile(`${OUT}/${name}`)
  console.log(`  ${OUT}/${name}`)
}

for (const size of [192, 512]) {
  const inner = Math.round(size * MASKABLE_SAFE_RATIO)
  const pad = Math.round((size - inner) / 2)
  const art = await sharp(svg, { density: 512 }).resize(inner, inner).png().toBuffer()
  await sharp({
    create: { width: size, height: size, channels: 4, background: '#0b2141' },
  })
    .composite([{ input: art, top: pad, left: pad }])
    .png()
    .toFile(`${OUT}/maskable-${size}.png`)
  console.log(`  ${OUT}/maskable-${size}.png`)
}

// Multi-size .ico for desktop browser tabs and pinned sites.
const ico32 = await sharp(svg, { density: 512 }).resize(32, 32).png().toBuffer()
await writeFile('src/app/favicon.ico', await toIco(ico32, 32))
console.log('  src/app/favicon.ico')

/** Minimal single-image ICO container around a PNG payload. */
async function toIco(png, size) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size === 256 ? 0 : size, 0)
  entry.writeUInt8(size === 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2)
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(header.length + entry.length, 12)
  return Buffer.concat([header, entry, png])
}

/**
 * iOS launch images.
 *
 * iOS will not scale one of these: a launch image is used only if its
 * dimensions match the device exactly, and otherwise the app boots to a white
 * flash. So one file per device, portrait only — the manifest pins the app to
 * portrait — over the brand navy, with the mark at a fifth of the width.
 *
 * The device list lives in src/lib/splash-devices.json and is shared with the
 * metadata that references these files, so the two cannot drift.
 */
await mkdir(SPLASH, { recursive: true })

for (const device of devices) {
  const mark = Math.round(device.width / 5)
  const art = await sharp(svg, { density: 512 }).resize(mark, mark).png().toBuffer()

  await sharp({
    create: {
      width: device.width,
      height: device.height,
      channels: 4,
      background: '#0b2141',
    },
  })
    .composite([
      {
        input: art,
        top: Math.round((device.height - mark) / 2),
        left: Math.round((device.width - mark) / 2),
      },
    ])
    .png({ compressionLevel: 9, palette: true })
    .toFile(`${SPLASH}/${device.name}.png`)
  console.log(`  ${SPLASH}/${device.name}.png`)
}
