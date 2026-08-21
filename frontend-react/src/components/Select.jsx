import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/**
 * Select-only combobox, built to the WAI-ARIA authoring practices.
 *
 * A native <select> could not show two lines per option, and the segmented row
 * that replaced it only works while there are four deals. There will not always
 * be four deals, so this is the control that scales.
 *
 * The parts of the pattern that matter, and that most hand rolled dropdowns get
 * wrong:
 *
 *   - DOM focus never leaves the trigger. The highlighted option is tracked with
 *     aria-activedescendant pointing at its id, which is how a screen reader is
 *     told what is active without the browser moving focus into the list.
 *   - The trigger carries role="combobox", aria-haspopup="listbox", aria-expanded
 *     and aria-controls. The popup carries role="listbox" and each row
 *     role="option" with aria-selected.
 *   - Enter and Space commit, Escape closes and returns focus, Home and End jump
 *     to the ends, and typing a letter jumps to the next option starting with it,
 *     which is the behaviour people expect from a native select and miss when it
 *     is gone.
 *
 * Options are `{ value, label, meta }`. `meta` is the quiet second line.
 */
export function Select({ value, onChange, options, label, placeholder = 'Select', className = '' }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const typed = useRef({ str: '', at: 0 });
  const id = useId();

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    if (open) setActive(selectedIndex);
  }, [open, selectedIndex]);

  // Close on an outside click or Escape anywhere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the active option in view when arrowing past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const commit = (i) => {
    onChange(options[i].value);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) return setOpen(true);
        return setActive((i) => Math.min(last, i + 1));
      case 'ArrowUp':
        e.preventDefault();
        if (!open) return setOpen(true);
        return setActive((i) => Math.max(0, i - 1));
      case 'Home':
        if (open) { e.preventDefault(); setActive(0); }
        return;
      case 'End':
        if (open) { e.preventDefault(); setActive(last); }
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        return open ? commit(active) : setOpen(true);
      case 'Escape':
        e.preventDefault();
        return setOpen(false);
      case 'Tab':
        return setOpen(false);
      default:
        break;
    }
    // Type-ahead. Letters typed within a second are treated as one search string,
    // which is how a native select behaves and what fingers already know.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typed.current.str = now - typed.current.at > 1000 ? e.key : typed.current.str + e.key;
      typed.current.at = now;
      const q = typed.current.str.toLowerCase();
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(q));
      if (hit >= 0) {
        setActive(hit);
        if (!open) commit(hit);
      }
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {label && (
        <label className="t-label block mb-1.5" id={`${id}-label`}>
          {label}
        </label>
      )}
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-labelledby={label ? `${id}-label` : undefined}
        aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className="input flex items-center justify-between gap-3 text-left"
        style={{ paddingRight: 12 }}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
            {selected?.label ?? placeholder}
          </span>
          {selected?.meta && <span className="block truncate t-small">{selected.meta}</span>}
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 transition-transform"
          style={{ color: 'var(--ink-muted)', transform: open ? 'rotate(180deg)' : 'none' }}
          aria-hidden="true"
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          aria-labelledby={label ? `${id}-label` : undefined}
          className="absolute z-50 mt-2 w-full max-h-72 overflow-auto card p-1.5 shadow-lg"
        >
          {options.map((o, i) => {
            const isSel = o.value === value;
            const isAct = i === active;
            return (
              <li
                key={o.value}
                id={`${id}-opt-${i}`}
                data-i={i}
                role="option"
                aria-selected={isSel}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
                className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-pointer"
                style={{ background: isAct ? '#f0f1f3' : 'transparent' }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-semibold" style={{ color: 'var(--ink)' }}>
                    {o.label}
                  </span>
                  {o.meta && <span className="block truncate t-small">{o.meta}</span>}
                </span>
                {isSel && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
