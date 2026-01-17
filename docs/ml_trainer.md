# ML Trainer

## Open the trainer
1. Run the dev server: `npm run dev`.
2. Open `http://localhost:5173/trainer.html?trainer=1`.

## Labeling workflow
1. Create a region with **New Region**.
2. Choose a labeling mode:
   - **Sparse**: mark positive examples only.
   - **Exhaustive**: fully label the region so everything unlabeled is treated as a negative.
3. Add trees, dense cover polygons, and signs with the labeling tools.
4. Select any label to edit or delete it in the inspector.

## Compute dataset analytics
- After labeling (e.g., ~300 trees), click **Compute dataset analytics** in the **Dataset** panel.
- This generates:
  - Counts by class
  - Crown radius histogram
  - Derived height histogram
  - Radius vs height scatter plot
  - Dense cover total area (sq m / sq ft)
- For **exhaustive** regions, this also samples negative patches.

## Export training bundle
1. Click **Export training bundle**.
2. The export renders zoomed patches (default 512px at the dataset zoom) with cached tiles for speed.
3. A ZIP is downloaded.

### ZIP contents
- `dataset.json`
  - Sample metadata
  - Per-sample annotations in patch pixel space
  - Tree annotations include center, radius, class, and derived height
  - Negative samples have empty annotations
  - Includes the source trainer dataset for round-tripping
- `images/{sampleId}.png`
  - Patch images for trees, signs, and negatives

## Import dataset
- Use **Import dataset.json** to load a previously exported `dataset.json`.
- This restores the trainer dataset (labels, regions, negatives) without needing image files.

## Review mode
1. Import a predictions JSON and click **Start review**.
2. Use `0` = Good, `1` = Bad, `3` = Wrong tree type (toggles pine/deciduous).
3. Dense cover predictions can be refined:
   - Drag corners to reshape.
   - Click an edge to add a corner.
   - Drag the center handle to move the polygon.
4. Use **Start dense cover review** to sample patches; accept to add dense cover, reject to skip.
