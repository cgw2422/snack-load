import { cn } from '@/lib/cn'

/**
 * The route map (spec §13).
 *
 * Deliberately an inline SVG rather than a tile library: it renders instantly on
 * a phone with no reception, adds nothing to the bundle, and needs no API key or
 * per-view billing. What a runner needs from a map on this screen is the shape
 * of the day and which stop is next — not street names. Turn-by-turn is a
 * hand-off to a real maps app, as docs/00 §6 says it should be.
 */

export type MapStop = {
  id: string
  sequence: number
  customerName: string
  latitude: number | null
  longitude: number | null
  status: string
}

const FINISHED = new Set(['COMPLETED', 'SKIPPED', 'NO_SALE', 'STORE_CLOSED', 'RESCHEDULED'])

export function RouteMap({
  stops,
  start,
  className,
}: {
  stops: MapStop[]
  start?: { latitude: number; longitude: number; name: string } | null
  className?: string
}) {
  const placed = stops.filter(
    (s): s is MapStop & { latitude: number; longitude: number } =>
      s.latitude !== null && s.longitude !== null,
  )

  if (placed.length === 0) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-card border border-line bg-surface-sunken px-6 py-10 text-center',
          className,
        )}
      >
        <p className="text-sm text-ink-muted">
          No stops on this route have an address we can place on a map.
        </p>
      </div>
    )
  }

  const points = start ? [{ ...start, isStart: true }, ...placed] : placed

  const lats = points.map((p) => p.latitude)
  const lons = points.map((p) => p.longitude)
  // A single stop would give a zero-size box; pad so it lands in the middle.
  const padLat = Math.max((Math.max(...lats) - Math.min(...lats)) * 0.15, 0.01)
  const padLon = Math.max((Math.max(...lons) - Math.min(...lons)) * 0.15, 0.01)

  const minLat = Math.min(...lats) - padLat
  const maxLat = Math.max(...lats) + padLat
  const minLon = Math.min(...lons) - padLon
  const maxLon = Math.max(...lons) + padLon

  const WIDTH = 800
  const HEIGHT = 560

  // Latitude is inverted because SVG y grows downward. Longitude degrees shrink
  // with latitude, so they are scaled by cos(lat) to keep the shape honest.
  const midLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180
  const lonScale = Math.cos(midLatRad)

  const spanLon = (maxLon - minLon) * lonScale
  const spanLat = maxLat - minLat
  const scale = Math.min(WIDTH / spanLon, HEIGHT / spanLat)

  const offsetX = (WIDTH - spanLon * scale) / 2
  const offsetY = (HEIGHT - spanLat * scale) / 2

  const project = (lat: number, lon: number) => ({
    x: offsetX + (lon - minLon) * lonScale * scale,
    y: offsetY + (maxLat - lat) * scale,
  })

  const projected = placed.map((stop) => ({ ...stop, ...project(stop.latitude, stop.longitude) }))
  const rawStart = start ? project(start.latitude, start.longitude) : null

  // Several stores in one town land on top of each other and the numbers become
  // unreadable — which is exactly the case a distributor's route hits most. Nudge
  // overlapping markers apart just enough to read them; the line still connects
  // the markers, so the shape of the day stays true.
  const separated = separate(
    rawStart ? [{ ...rawStart, pinned: true }, ...projected] : projected,
    WIDTH,
    HEIGHT,
  )
  const startPoint = rawStart ? separated[0] : null
  const placedPoints = projected.map((stop, i) => ({
    ...stop,
    ...separated[rawStart ? i + 1 : i],
  }))

  const path = [
    ...(startPoint ? [`M ${startPoint.x} ${startPoint.y}`] : []),
    ...placedPoints.map((p, i) => `${!startPoint && i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`),
  ].join(' ')

  const nextStop = placedPoints.find((s) => !FINISHED.has(s.status))

  return (
    <div className={cn('overflow-hidden rounded-card border border-line bg-navy-50 dark:bg-navy-950', className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-full w-full"
        role="img"
        aria-label={`Route map with ${placed.length} stops`}
      >
        <defs>
          <pattern id="route-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path
              d="M 40 0 L 0 0 0 40"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              className="text-navy-200 dark:text-navy-800"
            />
          </pattern>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill="url(#route-grid)" />

        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-navy-500"
          opacity="0.5"
        />

        {startPoint ? (
          <g>
            <rect
              x={startPoint.x - 13}
              y={startPoint.y - 13}
              width="26"
              height="26"
              rx="7"
              className="fill-navy-900"
            />
            <path
              d="M -6 2 L 0 -5 L 6 2 L 6 7 L -6 7 Z"
              transform={`translate(${startPoint.x} ${startPoint.y})`}
              className="fill-white"
            />
            <title>{start!.name}</title>
          </g>
        ) : null}

        {placedPoints.map((stop) => {
          const done = FINISHED.has(stop.status)
          const isNext = nextStop?.id === stop.id
          return (
            <g key={stop.id}>
              {isNext ? (
                <circle cx={stop.x} cy={stop.y} r="22" className="fill-flame-500" opacity="0.2" />
              ) : null}
              <circle
                cx={stop.x}
                cy={stop.y}
                r="15"
                className={
                  done ? 'fill-cash-500' : isNext ? 'fill-flame-500' : 'fill-navy-700'
                }
                stroke="white"
                strokeWidth="2.5"
              />
              <text
                x={stop.x}
                y={stop.y}
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-white text-[15px] font-bold"
              >
                {stop.sequence}
              </text>
              {/* One string child: an SVG <title> is parsed as raw text, so
                  React's separate text nodes do not survive hydration. */}
              <title>{`${stop.sequence}. ${stop.customerName}`}</title>
            </g>
          )
        })}
      </svg>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface-raised px-3 py-2 text-[11px] text-ink-muted">
        <Key className="bg-flame-500" label="Next stop" />
        <Key className="bg-navy-700" label="Remaining" />
        <Key className="bg-cash-500" label="Done" />
        {start ? <Key className="bg-navy-900" label={start.name} /> : null}
        <span className="ml-auto">Straight-line view · tap a stop for directions</span>
      </div>
    </div>
  )
}

/**
 * Pushes markers apart until none overlap, within the viewport. A handful of
 * relaxation passes is plenty for the ten-to-twenty stops a route actually has.
 */
function separate<T extends { x: number; y: number; pinned?: boolean }>(
  points: T[],
  width: number,
  height: number,
): { x: number; y: number }[] {
  const MIN_GAP = 36
  const MARGIN = 20
  const positions = points.map((p) => ({ x: p.x, y: p.y, pinned: p.pinned ?? false }))

  for (let pass = 0; pass < 60; pass++) {
    let moved = false

    for (let i = 0; i < positions.length; i++) {
      for (let k = i + 1; k < positions.length; k++) {
        const a = positions[i]
        const b = positions[k]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let distance = Math.hypot(dx, dy)

        if (distance >= MIN_GAP) continue

        // Exactly coincident points need an arbitrary direction to separate along.
        if (distance < 0.01) {
          const angle = (i * 137.5 * Math.PI) / 180
          dx = Math.cos(angle)
          dy = Math.sin(angle)
          distance = 1
        }

        const push = (MIN_GAP - distance) / 2
        const ux = (dx / distance) * push
        const uy = (dy / distance) * push

        // A pinned point (the depot) holds still and the other moves the full way.
        if (!a.pinned) {
          a.x -= b.pinned ? ux * 2 : ux
          a.y -= b.pinned ? uy * 2 : uy
        }
        if (!b.pinned) {
          b.x += a.pinned ? ux * 2 : ux
          b.y += a.pinned ? uy * 2 : uy
        }
        moved = true
      }
    }

    for (const position of positions) {
      position.x = Math.min(width - MARGIN, Math.max(MARGIN, position.x))
      position.y = Math.min(height - MARGIN, Math.max(MARGIN, position.y))
    }

    if (!moved) break
  }

  return positions.map(({ x, y }) => ({ x, y }))
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('size-2.5 rounded-full', className)} aria-hidden="true" />
      {label}
    </span>
  )
}
