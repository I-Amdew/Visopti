# Usage Guide

## Run the app
```bash
npm install
npm run dev
```
Open the local URL shown in the terminal (usually http://localhost:5173).

## Baseline workflow (address-first)
### 1) Find the address or area on the map
Pan and zoom to the location you want to analyze. Use **Basemap** to switch Street/Satellite/Auto street.

### 2) Lock the frame and load topography
In **Map & Terrain**, click **Lock frame** to freeze the view, then click **Load topography** to sync elevation with the canvas.

### 3) Draw zones
In **Tools**, choose **Viewer Poly**, **Candidate Poly**, and **Obstacle Poly/Ellipse** as needed. Use **Select** and **Erase** to adjust shapes.

### 4) Compute visibility
Click **Compute heatmap** and/or **Compute blindspots**.

### 5) Adjust settings (optional)
In **Settings**, adjust **Target height (ft)**, **Viewer height (ft)**, **Topography sample spacing (ft)**, and **Sample step (px)**. Overlay toggles and opacity sliders live here too.

### 6) Export/import project
Use **Export project JSON** and **Import project JSON** to save or share work.

## Advanced controls: roads, traffic, buildings (optional)
### 1) Choose a mode
In **Mode**, select **Auto mode** for OSM roads/buildings or **Custom mode** to draw your own roads.

### 2) Auto data (Auto mode)
In **Auto data**, click **Auto-populate roads & buildings** for the locked frame. Use **Refresh auto data** to update.

### 3) Set epicenter and radius
In **Epicenter**, the center defaults to the locked frame. Click **Set epicenter by click** to move it, then adjust **Radius (m)**.

### 4) Compute traffic
In **Traffic**, choose **Preset** (AM rush, PM rush, Neutral, Hourly). If you pick **Hourly**, set **Hour**. Set **Detail level**, then click **Compute traffic**. Toggle **Show traffic overlay** or **Show direction arrows** when needed.

### 5) Add/edit custom roads and overrides (Custom mode)
In **Road tools**, use **Add custom road**, **Edit selected road**, and **Delete selected road**. In the properties panel set **One-way**, **Show direction line**, **Cars/hour forward**, and **Cars/hour backward** (custom roads only). Load topography before computing traffic in Custom mode.
