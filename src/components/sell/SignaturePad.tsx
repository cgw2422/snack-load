'use client'

import { useEffect, useRef, useState } from 'react'
import { Eraser } from 'lucide-react'

/**
 * Signature capture (spec §27). A canvas with pointer events, so it works with a
 * finger, a stylus or a mouse. The PNG travels with the sale; a native app later
 * swaps the capture surface without changing storage or rendering (docs/05 §5).
 */
export function SignaturePad({
  onChange,
  label = 'Received by',
}: {
  onChange: (dataUrl: string | null) => void
  label?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [hasInk, setHasInk] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Match the backing store to the device so the line is not blurry.
    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * ratio
    canvas.height = rect.height * ratio

    const context = canvas.getContext('2d')
    if (!context) return
    context.scale(ratio, ratio)
    context.lineWidth = 2.5
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.strokeStyle = '#0b2141'
  }, [])

  function positionOf(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    const context = event.currentTarget.getContext('2d')
    if (!context) return
    const { x, y } = positionOf(event)
    context.beginPath()
    context.moveTo(x, y)
    drawing.current = true
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const context = event.currentTarget.getContext('2d')
    if (!context) return
    const { x, y } = positionOf(event)
    context.lineTo(x, y)
    context.stroke()
    if (!hasInk) setHasInk(true)
  }

  function end(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    drawing.current = false
    onChange(hasInk ? event.currentTarget.toDataURL('image/png') : null)
  }

  function clear() {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    setHasInk(false)
    onChange(null)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">{label}</span>
        {hasInk ? (
          <button
            type="button"
            onClick={clear}
            className="inline-flex items-center gap-1 text-sm font-semibold text-ink-muted hover:text-ink"
          >
            <Eraser className="size-3.5" aria-hidden="true" />
            Clear
          </button>
        ) : null}
      </div>

      <canvas
        ref={canvasRef}
        aria-label="Signature area"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        className="h-32 w-full touch-none rounded-xl border-2 border-dashed border-line-strong bg-surface"
      />

      {!hasInk ? (
        <p className="text-xs text-ink-subtle">Optional — have them sign with a finger.</p>
      ) : null}
    </div>
  )
}
