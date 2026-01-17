# ML integration

This folder supports training outside the app. The trainer UI exports labeled bundles and can
sync datasets directly into the repo during development.

## Sync a dataset from the trainer

1) Start the trainer (dev-only):
   - `npm run trainer`
   - or `npm run dev` and open `http://localhost:5173/trainer.html?trainer=1`.
2) Toggle **Sync dataset to repo (dev)** in the Dataset panel.

Synced files land in:

```
ml/datasets/active/
  dataset.json
  manifest.json
  images/{sampleId}.png
  labels/{sampleId}.json
```

## Train the tree/sign detector (YOLOv8)

Install Python deps:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r ml/requirements.txt
```

Run training:

```bash
npm run ml:train
```

Outputs (written directly to tracked paths):
- `ml/models/treesigns/latest.pt`
- `public/models/treesigns/latest.onnx`
- `public/models/treesigns/manifest.json`

The web app loads `public/models/treesigns/latest.onnx`, so after training the model is picked
up on the next page load (refresh if the dev server is already running).

Notes:
- Trainer labels are circles; the trainer sync JSON is converted to YOLO boxes on the fly.
- `dense_cover` labels are ignored for v1 detection. Add a separate classifier later if needed.

## Export a training bundle

1) Start the trainer (dev-only):
   - `npm run trainer`
   - or `npm run dev` and open `http://localhost:5173/trainer.html?trainer=1`.
2) In the trainer UI, click "Export bundle" to download a zip.
   - The zip contains `dataset.json` plus `images/*.png`.

Note: production builds only include `trainer.html` when `VITE_INCLUDE_TRAINER=1` is set.

## Convert a bundle to YOLO

```
node ml/scripts/convert_visopti_zip_to_yolo.js <zipPath> <outDir>
```

Or via npm:

```
npm run ml:convert:yolo -- <zipPath> <outDir>
```

Output structure:
- `images/train/*.png`
- `labels/train/*.txt`

Class mapping (YOLO id -> class):
- 0: tree_deciduous
- 1: tree_pine
- 2: billboard
- 3: stop_sign

Notes:
- `dense_cover` is excluded from YOLO detect v1.
- Tree circles are converted to boxes with `w = 2r`, `h = 2r`.
- Signs have no size in the source data, so the converter uses a small fixed box
  (`SIGN_BOX_SIZE_FRACTION` in `ml/scripts/convert_visopti_zip_to_yolo.js`).
- All samples go to `train`. Create your own train/val split if needed.

Smoke test with the fixture bundle:

```
node ml/scripts/convert_visopti_zip_to_yolo.js ml/fixtures/sample_bundle.zip ml/fixtures/yolo_out
```

## Train with an external tool

Most YOLO trainers expect a dataset config. Example `data.yaml`:

```yaml
path: /abs/path/to/outDir
train: images/train
val: images/train
names:
  0: tree_deciduous
  1: tree_pine
  2: billboard
  3: stop_sign
```

Train with your preferred tool (YOLOv5/YOLOv8/etc). This repo does not train in-browser.

## Export predictions back to the trainer

Trainer import expects a `PredictionSet` JSON that matches
`src/trainer/review/predictionsSchema.ts`.
See `ml/templates/predictions_example.json` for a valid template.
Use the trainer UI "Import predictions" button to load the file and then "Start review".

Each prediction must include:
- `id`: unique string
- `class`: `tree_pine | tree_deciduous | billboard | stop_sign | dense_cover`
- `centerLat`, `centerLon`: latitude/longitude
- `confidence`: 0..1
- Optional: `crownRadiusMeters` (trees), `yawDeg` (signs), `polygonLatLon` (dense_cover)

The `imagery.providerId` and `imagery.zoom` in the prediction set should match the bundle you
ran inference against.

### Converting model outputs to lat/lon + radius

When you run inference on exported bundle images, each sample includes
`centerLat`, `centerLon`, `zoom`, and `sizePx`. Convert YOLO boxes to predictions:

1) Convert YOLO normalized box to pixel center:
   - `cxPx = x * sizePx`
   - `cyPx = y * sizePx`
   - `boxWidthPx = w * sizePx`
   - `boxHeightPx = h * sizePx`

2) Convert pixel offset from the patch center to lat/lon using Web Mercator:

```js
const TILE_SIZE = 256;

function projectLatLon(lat, lon, zoom) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function unprojectLatLon(x, y, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon };
}

const centerWorld = projectLatLon(centerLat, centerLon, zoom);
const dx = cxPx - sizePx / 2;
const dy = cyPx - sizePx / 2;
const world = { x: centerWorld.x + dx, y: centerWorld.y + dy };
const { lat, lon } = unprojectLatLon(world.x, world.y, zoom);
```

3) Convert box size to radius in meters (trees):

```
const radiusPx = 0.5 * Math.min(boxWidthPx, boxHeightPx);
const metersPerPixel =
  (Math.cos((centerLat * Math.PI) / 180) * 2 * Math.PI * 6378137) /
  (256 * Math.pow(2, zoom));
const crownRadiusMeters = radiusPx * metersPerPixel;
```

4) Map the model class id to `class` strings and add `confidence` in the 0..1 range.

Finally, wrap predictions in a `PredictionSet` and import it from the trainer UI.
