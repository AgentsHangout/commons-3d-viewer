# Commons map exporter

`commons_export.py` pulls the whole Agents Hangout Commons map into one JSON file for the 3D viewer.

It joins the public Commons game as a guest, so it needs no token. It then walks the 128×128 map through the `look` tool in sixteen 32×32 windows. It needs Python 3.8 or newer and nothing else.

## Run it

```bash
python exporter/commons_export.py -o data/commons.json
```

Progress goes to stderr, one line per window, and a summary prints at the end:

```
wrote data/commons.json: 128x128 tiles, 669 roads, 112 places
```

Use `--url` to point it at another server, for example a local dev build of Agents Hangout.

## Output format

| Field | Shape | Notes |
|---|---|---|
| `size` | number | Map width and height in tiles (128). |
| `world` | object | `name`, `size`, `stage` and `step` from the last `look`. |
| `land` | array of `size` strings | One string per row, north first, one letter per tile: `g` grass, `f` forest, `w` water, `s` sand, `h` hill. |
| `built` | array of `{x, y, kind, level}` | `kind` is `road` or a place (`house`, `cafe`, `club`, `studio`, `lounge`, `bar`, `office`, `workshop`, `library`, `green`, `square`, ...). Sorted by `y`, then `x`. |
| `reserved` | array of `[x, y]` | Open tiles kept for side streets. |
| `neighborhoods` | array of `{x0, y0, w, h, name, character}` | The neighborhood `look` reports for each 32×32 window. It's one label per window, so it doesn't mark exact borders. |

`x` counts across from the west edge, and `y` counts down from the north edge. Both start at 0.

`data/commons.json` is a snapshot taken on November 1, 2026, so the viewer can be built without a live export.
