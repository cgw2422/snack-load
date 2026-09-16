/**
 * Stop ordering (spec §12).
 *
 * Pure geometry, no I/O. A distributor's route is a handful of stops in one
 * county, so we solve it well rather than approximately: nearest-neighbour for
 * a starting order, then 2-opt until it stops improving. Both are cheap at this
 * size and give a noticeably better answer than nearest-neighbour alone.
 *
 * This is straight-line distance, not driving distance. It is honest about that
 * — the numbers shown to a runner are labelled "as the crow flies", and the
 * turn-by-turn hand-off goes to a real maps app (docs/00 §6).
 */

export type Waypoint = {
  id: string
  latitude: number | null
  longitude: number | null
}

export type OptimizedRoute<T extends Waypoint> = {
  ordered: T[]
  /** Stops with no coordinates, kept in their original order at the end. */
  unplaced: T[]
  totalMiles: number
}

const EARTH_RADIUS_MILES = 3958.8

export function haversineMiles(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)))
}

type Placed<T> = T & { latitude: number; longitude: number }

function hasCoordinates<T extends Waypoint>(stop: T): stop is Placed<T> {
  return (
    stop.latitude !== null &&
    stop.longitude !== null &&
    Number.isFinite(stop.latitude) &&
    Number.isFinite(stop.longitude)
  )
}

export function pathMiles<T extends Waypoint>(
  stops: T[],
  start?: { latitude: number; longitude: number } | null,
): number {
  const placed = stops.filter(hasCoordinates)
  if (placed.length === 0) return 0

  let total = 0
  let previous = start ?? placed[0]
  // With a start point every stop is an edge; without one, the first stop is
  // where measuring begins.
  const from = start ? 0 : 1

  for (let i = from; i < placed.length; i++) {
    total += haversineMiles(previous, placed[i])
    previous = placed[i]
  }
  return total
}

/**
 * Orders stops to shorten the drive.
 *
 * `start` is the warehouse when we know it: a route begins where the truck is
 * loaded, and ignoring that produces an order that looks tidy on a map and
 * wastes twenty minutes in the morning.
 */
export function optimizeStopOrder<T extends Waypoint>(
  stops: T[],
  start?: { latitude: number; longitude: number } | null,
): OptimizedRoute<T> {
  const placed = stops.filter(hasCoordinates)
  const unplaced = stops.filter((stop) => !hasCoordinates(stop))

  // Only a single stop is order-free. With two and a known start, which one is
  // visited first is exactly the decision worth making.
  if (placed.length <= 1) {
    return { ordered: [...placed, ...unplaced], unplaced, totalMiles: pathMiles(placed, start) }
  }

  const seeded = nearestNeighbour(placed, start)
  const ordered = placed.length > 2 ? twoOpt(seeded, start) : seeded

  return {
    ordered: [...ordered, ...unplaced],
    unplaced,
    totalMiles: pathMiles(ordered, start),
  }
}

function nearestNeighbour<T extends Waypoint>(
  stops: Placed<T>[],
  start?: { latitude: number; longitude: number } | null,
): Placed<T>[] {
  const remaining = [...stops]
  const ordered: Placed<T>[] = []
  let current = start ?? remaining[0]

  if (!start) ordered.push(remaining.shift()!)

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const distance = haversineMiles(current, remaining[i])
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = i
      }
    }
    const next = remaining.splice(bestIndex, 1)[0]
    ordered.push(next)
    current = next
  }

  return ordered
}

/**
 * 2-opt: repeatedly reverse a segment when doing so shortens the path. Fixes the
 * crossings nearest-neighbour leaves behind, which is where most of the wasted
 * mileage on a real route lives.
 */
function twoOpt<T extends Waypoint>(
  stops: Placed<T>[],
  start?: { latitude: number; longitude: number } | null,
): Placed<T>[] {
  const route = [...stops]
  const n = route.length
  // Bounded so a pathological set of stops cannot stall the request.
  const maxPasses = 40

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false

    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const before = segmentCost(route, i, k, start)
        const candidate = [
          ...route.slice(0, i),
          ...route.slice(i, k + 1).reverse(),
          ...route.slice(k + 1),
        ]
        const after = segmentCost(candidate, i, k, start)

        // A hair of tolerance keeps floating-point noise from looping forever.
        if (after < before - 1e-9) {
          route.splice(0, n, ...candidate)
          improved = true
        }
      }
    }

    if (!improved) break
  }

  return route
}

/** Only the edges a reversal can change, so a pass stays cheap. */
function segmentCost<T extends Waypoint>(
  route: Placed<T>[],
  i: number,
  k: number,
  start?: { latitude: number; longitude: number } | null,
): number {
  const before = i === 0 ? start : route[i - 1]
  const after = route[k + 1]

  let cost = 0
  if (before) cost += haversineMiles(before, route[i])
  if (after) cost += haversineMiles(route[k], after)
  return cost
}

/**
 * A rough clock for the route planner. Deliberately simple and labelled as an
 * estimate: a real ETA needs a routing service, and a wrong one presented
 * confidently is worse than an honest guess.
 */
export function estimateRouteMinutes(args: {
  miles: number
  stopCount: number
  averageMph?: number
  minutesPerStop?: number
}): number {
  const mph = args.averageMph ?? 32
  const perStop = args.minutesPerStop ?? 14
  return Math.round((args.miles / mph) * 60 + args.stopCount * perStop)
}
