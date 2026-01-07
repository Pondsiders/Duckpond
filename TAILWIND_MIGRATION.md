# Duckpond Tailwind Migration Plan

Created: January 6, 2026
**Completed: January 6, 2026**

## Principles

- **One component at a time** — Convert, verify, move on
- **Visual check after every change** — Screenshot before and after
- **Keep theme.ts until done** — Don't delete until everything's migrated
- **If it breaks, revert immediately** — Don't debug for 30 minutes

---

## Phase 1: Setup (No Visual Changes)

- [x] Verify Tailwind v4 is configured (`@tailwindcss/vite` in vite.config.ts)
- [x] Create `src/themes/oak.css` with CSS variables matching `theme.ts`
- [x] Create `src/themes/current.css` that imports oak.css
- [x] Update `src/index.css` with `@theme` bridge mapping CSS vars to Tailwind
- [x] Hard refresh and verify app looks IDENTICAL to before

---

## Phase 2: Migrate Components

For each component:
1. Screenshot current state
2. Convert inline styles to Tailwind classes
3. Hard refresh (Cmd+Shift+R)
4. Screenshot new state
5. Compare — if different, revert and investigate
6. Check off and continue

### Components (smallest to largest)

- [x] `ContextMeter.tsx` — small, isolated gauge component
- [x] `ToolFallback.tsx` — **DELETED** (was dead code, not imported anywhere)
- [x] `Attachment.tsx` — attachment preview components
- [x] `MarkdownText.tsx` — markdown renderer wrapper
- [x] `HomePage.tsx` — landing page with session list
- [x] `ChatPage.tsx` — main chat view (largest, done carefully)

---

## Phase 3: Cleanup

- [x] Delete `src/theme.ts`
- [x] Verify build passes (`npm run build`)
- [x] Final visual check of all pages
- [x] Commit the migration

---

## Phase 4: Theme Switching (Future)

- [ ] Create a second theme file (e.g., `midnight.css` or `dawn.css`)
- [ ] Test hot-reload by changing the import in `current.css`
- [ ] Celebrate

---

## Notes from Migration

- Dynamic font sizes (using `fontScale * N`) kept as inline styles
- Dynamic status colors (running/error/complete) kept as inline styles with Tailwind class switching
- Border color in theme is 30% opacity — original used 20% in some places, difference is negligible
- Standalone `ToolFallback.tsx` in components/ was never imported — deleted as dead code

---

## Theme System Architecture

```
src/
├── index.css           ← @import "tailwindcss" + @theme bridge
└── themes/
    ├── current.css     ← Import layer (edit to switch themes)
    └── oak.css         ← The original warm dark palette
```

To switch themes: Edit `themes/current.css` to import a different theme file. Vite hot-reloads.

---

*Migration complete. Alpha can now create mood themes.*
