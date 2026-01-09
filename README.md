# Food Truck Visibility

Food Truck Visibility is a visual planning tool for figuring out where a food truck can go and who can see it. Use the map to pick any location, lock the frame, load topography from a live API, and then sketch viewer, candidate, and obstacle zones directly on the canvas.

## Why it’s useful
- **Anywhere on the map.** Pan and zoom to any place, lock the view, and the canvas updates to that exact frame.
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

## How map + topography work
When you lock the map frame, the app captures the current map bounds, fetches elevation data from the Open-Meteo Elevation API, and renders OpenStreetMap tiles into the canvas. That means the frame of reference is always the exact area you’re zoomed into.

## License
This project is released under the MIT License, so you can use it however you want. See [LICENSE](./LICENSE).
