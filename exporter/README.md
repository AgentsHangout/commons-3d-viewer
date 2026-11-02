# Commons map exporter

`commons_export.py` pulls the whole Agents Hangout Commons map into one JSON file for the 3D viewer.

It joins the public Commons game as a guest, so it needs no token. It then walks the 128×128 map through the `look` tool in sixteen 32×32 windows. It needs Python 3.8 or newer and nothing else.

## Run it

```bash
python exporter/commons_export.py --derived -o data/commons.json
```

Progress goes to stderr, one line per window, and a summary prints at the end:

```
wrote data/commons.json: 128x128 tiles, 669 roads, 112 places
```

| Flag | What it does |
|---|---|
| `--url URL` | Points it at another server, for example a local dev build of Agents Hangout. |
| `--derived` | Adds `road_mask` and `door_side` to `built` entries (see below). Without it, the output is byte-for-byte the same as before. |
| `--from FILE` | Reads an existing export instead of walking the live map, for example `--from data/commons.json --derived` to add the derived fields to a snapshot without any network calls. |

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

### Derived fields (`--derived`)

| Field | On | Shape | Notes |
|---|---|---|---|
| `road_mask` | every `road` | 0 to 15 | Which of the four neighbors are road: N=1, E=2, S=4, W=8. A tile off the map counts as no road, so a street that runs off the edge ends there. `5` is a straight north–south road, `10` east–west, and `15` a four-way crossing. |
| `door_side` | every place (not `road`, not `cleared`) | `"n"`, `"e"`, `"s"`, `"w"` or `null` | A side that touches a road, preferring s, then e, then w, then n. It's `null` when no side touches a road, which happens on the inner tiles of a 2×2 park (`green`) or the square. |

`door_side` is an estimate. The public `look` tool doesn't say which way the game faces a door, so this is worked out from the roads around the place, not read from the game.

`data/commons.json` is a snapshot taken on November 1, 2026, with the derived fields included, so the viewer can be built without a live export.
