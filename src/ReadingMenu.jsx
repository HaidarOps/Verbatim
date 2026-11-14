import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  FONT_SIZES,
  FONTS,
  LINE_SPACINGS,
  MARGINS,
  THEMES,
  stepFontSize,
} from './readingSettings.js'

// The "Aa" button and its menu: text size, font, line spacing, margins and
// theme. `settings` / `onChange(next)` as in readingSettings.js.
export default function ReadingMenu({ settings, onChange }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)

  // Close on Escape or a click anywhere else.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    const onDown = (e) => box.current && !box.current.contains(e.target) && setOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  const set = (patch) => onChange({ ...settings, ...patch })
  const smallest = settings.fontSize === FONT_SIZES[0]
  const largest = settings.fontSize === FONT_SIZES.at(-1)

  return (
    <div className="reading-menu" ref={box}>
      <button
        className={`align-button reading-toggle${open ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Text size, font, spacing, margins and theme"
      >
        Aa
      </button>
      {open && (
        <div className="reading-panel" role="dialog" aria-label="Reading settings">
          <div className="reading-row">
            <span className="reading-label">Text size</span>
            <div className="reading-size">
              <button
                className="reading-step"
                onClick={() => set({ fontSize: stepFontSize(settings.fontSize, -1) })}
                disabled={smallest}
                aria-label="Smaller text"
              >
                A−
              </button>
              <span className="reading-value" aria-live="polite">
                {settings.fontSize}%
              </span>
              <button
                className="reading-step reading-step-big"
                onClick={() => set({ fontSize: stepFontSize(settings.fontSize, 1) })}
                disabled={largest}
                aria-label="Larger text"
              >
                A+
              </button>
            </div>
          </div>

          <Choice label="Font" table={FONTS} value={settings.font} onPick={(font) => set({ font })} />
          <Choice
            label="Line spacing"
            table={LINE_SPACINGS}
            value={settings.lineSpacing}
            onPick={(lineSpacing) => set({ lineSpacing })}
          />
          <Choice label="Margins" table={MARGINS} value={settings.margins} onPick={(margins) => set({ margins })} />
          <Choice
            label="Theme"
            table={THEMES}
            value={settings.theme}
            onPick={(theme) => set({ theme })}
            swatch={(key) => ({ background: THEMES[key].bg, color: THEMES[key].fg })}
          />

          <button className="reading-reset" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  )
}

// A row of mutually exclusive options, e.g. Book / Serif / Sans.
function Choice({ label, table, value, onPick, swatch }) {
  return (
    <div className="reading-row">
      <span className="reading-label">{label}</span>
      <div className="reading-choices" role="radiogroup" aria-label={label}>
        {Object.entries(table).map(([key, option]) => (
          <button
            key={key}
            role="radio"
            aria-checked={value === key}
            className={`reading-choice${value === key ? ' active' : ''}`}
            style={swatch ? swatch(key) : undefined}
            onClick={() => onPick(key)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
