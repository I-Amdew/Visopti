# Visopti

Visopti is a lightweight web app for evaluating line-of-sight coverage in real-world terrain. Use the map to pick any location, lock the frame, pull live topography, and sketch viewer, candidate, and obstacle zones directly on the canvas.

## Why it’s useful
- **Anywhere on the map.** Pan and zoom to any place, lock the view, and the canvas updates to that exact frame.
- **Street or satellite basemaps.** Toggle between street and satellite tiles for the context you need.
- **Terrain-aware.** Elevation data is pulled on demand so visibility reflects real topography.
- **Designed for quick decisions.** Draw zones, compute heatmaps, and export projects without leaving the browser.

## Quick start
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the dev server:
   ```bash
   npm run dev
   ```
3. Open the local URL shown in the terminal (usually http://localhost:5173).

For hands-on steps, see **[USAGE.md](./USAGE.md)**.

## Primary workflow (baseline)
1. Find an address or area on the map (pan/zoom as needed). Use **Basemap** to switch Street/Satellite/Auto street.
2. In **Map & Terrain**, click **Lock frame**, then **Load topography**.
3. In **Tools**, draw **Viewer Poly**, **Candidate Poly**, and **Obstacle Poly/Ellipse**; edit with **Select**/**Erase**.
4. Click **Compute heatmap** or **Compute blindspots**. Export via **Export project JSON** when needed.
5. Optional: adjust **Target height (ft)**, **Viewer height (ft)**, and sampling controls in **Settings**.

## How map + topography work
When you lock the map frame, the app captures the current map bounds, fetches elevation data from the Open-Meteo Elevation API, and renders map tiles into the canvas. That means the frame of reference is always the exact area you’re zoomed into.

The elevation requests are batched and the sampling density is adjustable (in feet), so you can trade detail for faster visibility processing when you’re exploring large areas.

## Advanced controls: Roads, traffic, buildings
Roads/traffic/buildings live under advanced controls in the control panel: **Mode**, **Auto data**, **Epicenter**, **Traffic**, **Road tools**.
- **Auto mode / Custom mode.** Use **Auto mode** for OSM roads/buildings or **Custom mode** to draw your own.
- **Auto-populate roads & buildings.** Pulls OSM roads and building footprints for the locked frame; use **Refresh auto data** to update.
- **Epicenter.** Click **Set epicenter by click** and adjust **Radius (m)** to bias flow.
- **Traffic.** Choose **Preset** (AM rush, PM rush, Neutral, Hourly), set **Detail level**, then **Compute traffic**. Toggle **Show traffic overlay** or **Show direction arrows**.
- **Road tools.** **Add custom road**, **Edit selected road**, **Delete selected road**; set **One-way**, **Show direction line**, **Cars/hour forward**, **Cars/hour backward** (custom roads only).

## Performance Notes
- Higher detail settings (Traffic **Detail level**, tighter sampling) increase compute time.
- Traffic simulation runs in a worker to keep the UI responsive.

## Data & Licensing Notes
- Roads/buildings are fetched from OpenStreetMap via the Overpass API.
- Basemap tiles are OpenStreetMap (Street) and Esri World Imagery (Satellite); usage is subject to provider terms.

## Typical use cases
- Choosing a high-visibility placement for pop-ups, kiosks, or signage.
- Comparing coverage between multiple candidate sites within a single map frame.
- Exploring blindspots caused by terrain and obstacles before you deploy.

## License
This project is released under the MIT License, so you can use it however you want. See [LICENSE](./LICENSE).

## Planned updates
- Road-following visibility cones with configurable angular width.
