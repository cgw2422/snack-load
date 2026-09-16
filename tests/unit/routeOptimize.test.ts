import { describe, expect, it } from 'vitest'
import {
  estimateRouteMinutes,
  haversineMiles,
  optimizeStopOrder,
  pathMiles,
} from '@/server/domain/routeOptimize'

const at = (id: string, latitude: number, longitude: number) => ({ id, latitude, longitude })

describe('distance', () => {
  it('measures a known distance', () => {
    // Sandusky to Dover, Ohio — about 92 miles as the crow flies.
    const miles = haversineMiles(
      { latitude: 41.4489, longitude: -82.7079 },
      { latitude: 40.5209, longitude: -81.4746 },
    )
    expect(miles).toBeGreaterThan(85)
    expect(miles).toBeLessThan(100)
  })

  it('is zero between a point and itself', () => {
    expect(haversineMiles({ latitude: 41, longitude: -82 }, { latitude: 41, longitude: -82 })).toBe(0)
  })

  it('is symmetric', () => {
    const a = { latitude: 41.4489, longitude: -82.7079 }
    const b = { latitude: 40.5209, longitude: -81.4746 }
    expect(haversineMiles(a, b)).toBeCloseTo(haversineMiles(b, a), 9)
  })
})

describe('stop ordering', () => {
  it('leaves one or two stops alone', () => {
    const stops = [at('a', 41, -82)]
    expect(optimizeStopOrder(stops).ordered.map((s) => s.id)).toEqual(['a'])
  })

  it('walks a line of stops in order rather than zig-zagging', () => {
    // Four stops strung west to east, handed over shuffled.
    const stops = [at('c', 41, -82.0), at('a', 41, -84.0), at('d', 41, -81.0), at('b', 41, -83.0)]
    const { ordered } = optimizeStopOrder(stops, { latitude: 41, longitude: -85 })
    expect(ordered.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('never makes a route longer than the order it was given', () => {
    const stops = [
      at('1', 41.4489, -82.7079),
      at('2', 40.4898, -81.4457),
      at('3', 40.5209, -81.4746),
      at('4', 40.5031, -81.6432),
      at('5', 40.5978, -81.5293),
      at('6', 41.3964, -82.5549),
      at('7', 41.4192, -82.6851),
    ]
    const start = { latitude: 41.44, longitude: -82.71 }

    const before = pathMiles(stops, start)
    const { ordered, totalMiles } = optimizeStopOrder(stops, start)

    expect(totalMiles).toBeLessThanOrEqual(before)
    expect(ordered).toHaveLength(stops.length)
    expect(new Set(ordered.map((s) => s.id)).size).toBe(stops.length)
  })

  it('undoes a crossing that nearest-neighbour would leave behind', () => {
    // A square visited corner-to-corner crosses itself; the fix is 2-opt's job.
    const stops = [at('a', 0, 0), at('c', 1, 1), at('b', 0, 1), at('d', 1, 0)]
    const { totalMiles } = optimizeStopOrder(stops, { latitude: -0.1, longitude: 0 })
    const crossing = pathMiles(stops, { latitude: -0.1, longitude: 0 })
    expect(totalMiles).toBeLessThan(crossing)
  })

  it('starts from the warehouse when it knows where that is', () => {
    const stops = [at('far', 41, -80), at('near', 41, -83.9)]
    const { ordered } = optimizeStopOrder(stops, { latitude: 41, longitude: -84 })
    expect(ordered[0].id).toBe('near')
  })

  it('keeps stops with no coordinates instead of dropping them', () => {
    const stops = [
      at('placed', 41, -82),
      { id: 'no-address', latitude: null, longitude: null },
      at('also-placed', 41, -83),
    ]
    const { ordered, unplaced } = optimizeStopOrder(stops)
    expect(ordered).toHaveLength(3)
    expect(unplaced.map((s) => s.id)).toEqual(['no-address'])
    // Unplaced stops land at the end, where a person can slot them in.
    expect(ordered[ordered.length - 1].id).toBe('no-address')
  })

  it('handles a route where nothing has coordinates', () => {
    const stops = [
      { id: 'a', latitude: null, longitude: null },
      { id: 'b', latitude: null, longitude: null },
    ]
    const { ordered, totalMiles } = optimizeStopOrder(stops)
    expect(ordered.map((s) => s.id)).toEqual(['a', 'b'])
    expect(totalMiles).toBe(0)
  })
})

describe('route time estimate', () => {
  it('counts driving and time spent in the store', () => {
    // 42 miles at 32mph is ~79 minutes; 12 stops at 14 minutes is 168.
    expect(estimateRouteMinutes({ miles: 42, stopCount: 12 })).toBe(247)
  })

  it('is zero for an empty route', () => {
    expect(estimateRouteMinutes({ miles: 0, stopCount: 0 })).toBe(0)
  })
})
