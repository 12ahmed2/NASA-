# SOLDOC Virtual Farm

This project is the Phase 1 foundation for a virtual farm and world-creation experience.

## Quick start

1. Install dependencies:
   npm install
2. Start the development server:
   npm run dev
3. Open the local Vite URL shown in the terminal.

## Notes

- The app opens directly to the dashboard without login or account creation. Farms are saved in the current browser's localStorage.
- The farm map uses React Leaflet. With a MapTiler key, new farms open on MapTiler satellite imagery and offer Hybrid and OpenStreetMap views; the selected layer is saved with each farm. Without a MapTiler key, the app uses real OpenStreetMap tiles as the working fallback.
- The 3D digital twin lets you switch between MapTiler Satellite and Mapbox Satellite without changing the saved farm boundary or camera. The choice is kept for the current browser session. When zooming closer, it requests higher-zoom tiles for the farm bounds and keeps the previous texture visible while new tiles load. Successful image tiles are cached for the page lifetime. A provider's tile zoom is not evidence of its source imagery's native resolution; native resolution is reported as unknown.
- Copy `.env.example` to `.env` in the project root and configure `VITE_MAPTILER_API_KEY` and/or `VITE_MAPBOX_ACCESS_TOKEN`. Mapbox uses its documented `mapbox.satellite` TileJSON and raster tile APIs; restrict the public token to the required styles/tiles and your website origins. A Vite `VITE_` token is exposed to browsers, not a server-side secret. Confirm Mapbox and MapTiler current account, attribution, usage, and licensing terms before deployment. Restart Vite after changing `.env`.
- Never commit a real API key or token. `.env` is ignored by git. MapTiler, Mapbox, and OpenStreetMap attribution links remain visible in the 3D scene.
- The app uses Photon for location autocomplete and Turf.js to measure the drawn boundary as a reference. Farmers enter the official land area themselves in Egyptian feddans or square meters; the app converts using 1 feddan = 4,200 m² and saves the entered area alongside the unchanged boundary coordinates.
- The farm digital twin renders the saved irregular polygon in a local Web Mercator coordinate system and maps real MapTiler satellite/hybrid XYZ tiles onto its exact shape. It limits imagery requests to the polygon's tile bounds and falls back to actual OpenStreetMap tiles when MapTiler imagery is unavailable. The current surface is intentionally flat; no DEM/elevation source is connected. Satellite credits remain visible in the scene.
- The digital twin uses React Three Fiber and Three.js for an aerial orbit camera. Saved manually verified plot polygons and excluded-area polygons are shown as separate geographic layers over the satellite surface. Roads, paths, canals, buildings, and water have distinct colors; these overlays use the coordinates the farmer traced and are not inferred from imagery.
- Agricultural plots and non-plantable areas are manually traced and saved as separate geographic polygons. SOLDOC does not automatically infer plot boundaries, roads, canals, buildings, or crop cover from RGB satellite imagery; it never silently treats the full farm outline as plantable. Plot and obstacle edits are checked against the outer farm boundary and overlapping regions.
- The farm setup ends with an optional crop-suggestions screen. The current recommendation provider is an explicit placeholder with no data-backed crop suggestions; users may skip it and enter the simulation. The simulation starts without virtual crops. Legacy planting-plan records remain saved for compatibility but are not rendered as crops.
- Irrigation canals and other infrastructure are displayed only when manually traced as excluded-area polygons. These polygons preserve their geographic positions and are visibly distinguished from plots, but do not encode flow direction, start/end points, or branches. The live satellite image is not vegetation-cleared; use the optional externally processed image workflow when a reviewed clean image is available.
- For a vegetation-free layer, upload a separately processed PNG/JPEG/WebP and enter its true geographic bounds. The image is stored locally in IndexedDB and rendered only inside the farm polygon; original satellite tiles remain unchanged underneath. SOLDOC does not automatically remove vegetation or produce a clean image. Geospatial alignment depends on the uploaded image and bounds being correctly supplied; automatic inpainting/segmentation requires a dedicated GIS or imagery-processing workflow and human review.
