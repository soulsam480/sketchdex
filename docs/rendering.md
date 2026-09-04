# Rendering

`render_scene` draws the scene exactly as Excalidraw exports it and returns a
PNG, so an agent can look at its own work. It needs a Chromium-based browser
on the machine and finds one on its own: Chrome, Chromium, Edge or Brave, in
the usual install locations on macOS, Windows and Linux. Nothing is
downloaded. In a git checkout with `electron` installed, Electron is the
fallback.

`SKETCHDEX_BROWSER=/path/to/binary` in the server's environment overrides
the search. Use it when the browser is somewhere unusual, or to pick one.

## What to expect

- The first render after the server starts takes a few seconds while the
  browser comes up. After that about a second and a half.
- The PNG is always written to a file in the system temp folder
  (`sketchdex-renders/`) and its path is in the result, so it can be read or
  attached even when it was too large to show inline.
- Above roughly 150 KB the image travels as a downscaled preview plus the
  path to the full file. Clients truncate over-long results silently, which
  is why the ceiling is conservative. `SKETCHDEX_INLINE_LIMIT` (characters
  of base64) changes it.
- A page much taller or wider than it is high comes back as a few tiles,
  each labelled with the scene box it shows. Pass `tiles: 1` for a single
  image.
- `region` renders one box in scene coordinates, the way to look closely at
  one part. `ids` renders only those elements. `transparent: true` leaves
  the paper out, for dropping a sketch onto a slide or a web page.
- `scale` 1 to 3 sets the pixel density; `maxWidth` caps the long edge.

`check_scene` finds layout problems by geometry (hidden text, overflowing
labels, dangling arrows, strays) without a browser, and is far cheaper. Use
it after a batch of edits; render when the question is how it looks.
