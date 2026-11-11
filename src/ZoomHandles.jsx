import { useRef } from 'react'

const MIN_WIDTH = 480
const MAX_WIDTH = 820

function ZoomHandles() {
  const start = useRef(null)
  const rafId = useRef(null)

  function onPointerDown(side) {
    return (e) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      const startWidth =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            '--root-width',
          ),
        ) || MIN_WIDTH
      start.current = { x: e.clientX, width: startWidth, side }
    }
  }

  function onPointerMove(e) {
    if (!start.current) return
    const { x, width, side } = start.current
    const clientX = e.clientX

    if (rafId.current) cancelAnimationFrame(rafId.current)
    rafId.current = requestAnimationFrame(() => {
      const diff = side === 'right' ? clientX - x : x - clientX
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width + diff * 2))
      document.documentElement.style.setProperty('--root-width', `${next}px`)
    })
  }

  function onPointerUp(e) {
    e.currentTarget.releasePointerCapture(e.pointerId)
    start.current = null
    if (rafId.current) {
      cancelAnimationFrame(rafId.current)
      rafId.current = null
    }
  }

  return (
    <>
      <div
        className="zoom-handle zoom-handle-left"
        onPointerDown={onPointerDown('left')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div
        className="zoom-handle zoom-handle-right"
        onPointerDown={onPointerDown('right')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </>
  )
}

export default ZoomHandles
