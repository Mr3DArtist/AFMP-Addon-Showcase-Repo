# Auto Facial MoCap Pro — Showcase

A modern, responsive product landing page for the **Auto Facial MoCap Pro** Blender add-on.
Single-file HTML + CSS + Vanilla JS. No build step, no frameworks, no server required —
drop it in a GitHub Pages repo and it just works.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The landing page (everything is inlined: styles, markup, scripts) |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is (no Jekyll processing) |
| `README.md` | This file |

## Deploy to GitHub Pages

1. **Create a repository** on GitHub, e.g. `auto-facial-mocap-pro` (public or private —
   Pages works with both; free accounts need public for Pages).
2. **Put these files in the repo root:**
   - `index.html`
   - `.nojekyll`
   - `README.md` (optional)
3. **Push to GitHub** (default branch `main`):
   ```bash
   git init
   git add index.html .nojekyll README.md
   git commit -m "Add Auto Facial MoCap Pro landing page"
   git branch -M main
   git remote add origin https://github.com/<your-username>/auto-facial-mocap-pro.git
   git push -u origin main
   ```
4. **Enable Pages:** GitHub → repo → **Settings** → **Pages** →
   *Source*: **Deploy from a branch** → Branch: `main`, folder: `/ (root)` → **Save**.
5. Wait a minute or two. Your site is live at:
   ```
   https://<your-username>.github.io/auto-facial-mocap-pro/
   ```

### Alternative: project site in a subfolder
If you'd rather keep your main repo clean, create a branch named `gh-pages` with just these
files, and point Pages at the `gh-pages` branch instead.

## Customizing

- **Media placeholders** — search `index.html` for `MEDIA PLACEHOLDER`. Each one marks where
  to drop a real demo MP4 / WebM / GIF or screenshot. The hero and feature-row visuals are
  currently styled gradient placeholders so the page looks complete before you add footage.
- **Colors / theme** — all colors come from the four CSS custom properties at the top of the
  `<style>` block (`--color-primary`, `--color-secondary`, `--color-tertiary`, `--color-accent`)
  plus a `.dark` override. Change them in one place.
- **Pricing / copy / links** — plain HTML; edit the text directly in `index.html`.
- **Fonts** — loaded from Google Fonts with a system-font fallback. Works offline too.

## Notes

- The page respects the visitor's saved light/dark preference (localStorage) and falls back to
  their OS setting on first visit.
- Fully responsive: mobile, tablet, and desktop.
