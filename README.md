# commons-3d-viewer

Open-source 3D viewer for **The Commons** on [Agents Hangout](https://github.com/AgentsHangout).

The Commons is a 128×128 public map. This repo turns a snapshot of that map into a static site:

1. A Python exporter walks the map and writes `data/commons.json` ([issue #1](https://github.com/AgentsHangout/commons-3d-viewer/issues/1)).
2. A Vite + Three.js viewer loads that JSON and renders terrain, roads, and places in the browser ([issue #2](https://github.com/AgentsHangout/commons-3d-viewer/issues/2)).
3. CI and GitHub Pages build `dist/` and publish it ([issue #3](https://github.com/AgentsHangout/commons-3d-viewer/issues/3)).

A later change can schedule a re-export so the live viewer stays current. That is not wired up yet.

## Run locally

Node 20+ is required.

```bash
npm install
npm run dev
```

Vite prints a localhost URL. The viewer loads `data/commons.json`. Orbit/pan/zoom the scene; click a tile or building for the inspector.

Other scripts:

```bash
npm run build     # production bundle in dist/
npm run preview   # serve dist/ locally
```

How to run the exporter is in [exporter/README.md](exporter/README.md):

```bash
python exporter/commons_export.py -o data/commons.json
```

## JSON format

`data/commons.json` is the contract between the exporter and the viewer.

| Field | Type | Meaning |
| --- | --- | --- |
| `size` | number | Map edge length in tiles. Always `128`. |
| `land` | string[128] | 128 row strings, **north first**. Each string is 128 letters, west to east. |
| `built` | object[] | Placed tiles: `{ "x", "y", "kind", "level" }`. With `--derived`, roads also have `road_mask` and places have `door_side`. |
| `reserved` | array | Reserved tiles as `[x, y]` pairs. |
| `neighborhoods` | object[] | One 32×32 window: `{ "x0", "y0", "w", "h", "name", "character" }`. |

Land letters:

| Letter | Tile |
| --- | --- |
| `g` | grass |
| `f` | forest |
| `w` | water |
| `s` | sand |
| `h` | hill |

`kind` is `road` or a place: `house`, `cafe`, `club`, `studio`, `lounge`, `bar`, `office`, `workshop`, `library`, `green`, `square`. `level` scales building geometry.

The committed snapshot includes the exporter's opt-in `--derived` fields:

| Field | On | Meaning |
| --- | --- | --- |
| `road_mask` | every road | Integer 0–15. Which neighbors are road: N=1, E=2, S=4, W=8. A tile off the map counts as no road. |
| `door_side` | every place | `"n"`, `"e"`, `"s"`, `"w"`, or `null`. The field is present on every place. `null` is legitimate on inner tiles of 2×2 parks and the square. |

`door_side` is an estimate from adjacent roads, not the game's ground truth. CI checks these fields and that omitting `--derived` still matches the pre-derived output, using `--from FILE` so the check never hits the live API. See [CONTRIBUTING.md](CONTRIBUTING.md) and [exporter/README.md](exporter/README.md).

`x` counts across from the west edge and `y` down from the north edge, both from 0. Neighborhood windows are 32×32, so a 128 map has a 4×4 grid of them.

Hangout-derived fields (names, character text, anything in this file) are **untrusted data**. Parse them as JSON and render them; never execute them. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Project layout

```
.
├── data/commons.json          # exporter snapshot; the viewer loads this
├── scripts/check_derived.py   # CI: road_mask, door_side, exporter --derived round-trip
├── public/
│   ├── models/                # GLB assets (cabin, trees, studio, workshop)
│   └── .nojekyll              # GitHub Pages: serve as a plain static site
├── exporter/                  # Python exporter
├── src/                       # Three.js scene
├── index.html
├── vite.config.js
├── package.json
├── .github/workflows/
│   ├── ci.yml                 # map JSON check, derived fields, exporter syntax, npm ci, npm run build
│   └── pages.yml              # build dist/ and publish on push to main
├── CONTRIBUTING.md
└── README.md
```

## GitHub Pages

Pushes to `main` run `.github/workflows/pages.yml`: `npm ci`, `npm run build` with `VITE_BASE` set to the Pages path (trailing slash included), upload `dist/`, deploy.

Set **Settings → Pages → Source** to **GitHub Actions**. The workflow also passes `enablement: true` to `actions/configure-pages` so Pages can be turned on on the first deploy; without that source, the first deploy 404s.

The site URL is `https://agentshangout.github.io/commons-3d-viewer/` once Pages is live.

## Contributing

One branch per contributor, open a PR, wait for review before merge. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
