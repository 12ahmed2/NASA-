import * as turf from '@turf/turf';
import type { GeoPoint } from './FarmMap';

export type ExcludedAreaType = 'road' | 'path' | 'canal' | 'building' | 'water' | 'other';
export type LandUseKind = 'plot' | 'excluded' | 'irrigation';

export interface LandUseRegion {
  id: string;
  name: string;
  kind: LandUseKind;
  excludedType?: ExcludedAreaType;
  coordinates: GeoPoint[];
}

export interface PlantingPlan {
  id: string;
  plotId: string;
  cropType: 'wheat' | 'corn' | 'vegetable';
  spacingMeters: number;
  safetyMarginMeters: number;
}

const makePolygon = (coordinates: GeoPoint[]) => turf.polygon([[
  ...coordinates.map((point) => [point.longitude, point.latitude]),
  [coordinates[0].longitude, coordinates[0].latitude],
]]);

export const validateLandUseRegion = (
  coordinates: GeoPoint[],
  farmCoordinates: GeoPoint[],
  regions: LandUseRegion[],
  kind: LandUseRegion['kind'],
  currentRegionId?: string,
) => {
  if (coordinates.length < (kind === 'irrigation' ? 2 : 3)) {
    return kind === 'irrigation'
      ? 'Add at least two points to define the irrigation route.'
      : 'Add at least three points to close this boundary.';
  }
  if (coordinates.some((point) => !Number.isFinite(point.latitude)
    || !Number.isFinite(point.longitude)
    || Math.abs(point.latitude) > 90
    || Math.abs(point.longitude) > 180)) {
    return 'This boundary contains invalid geographic coordinates.';
  }

  if (kind === 'irrigation') {
    let farm: turf.Feature<turf.Polygon>;
    try {
      farm = makePolygon(farmCoordinates);
    } catch {
      return 'The farm boundary is not valid.';
    }
    const allInsideFarm = coordinates.every((point) => turf.booleanPointInPolygon(turf.point([point.longitude, point.latitude]), farm));
    if (!allInsideFarm) return 'Keep irrigation lines inside the farm boundary.';
    return '';
  }

  let candidate: turf.Feature<turf.Polygon>;
  try {
    candidate = makePolygon(coordinates);
    if (turf.kinks(candidate).features.length > 0) return 'This boundary crosses itself. Adjust the points and try again.';
    if (turf.area(candidate) <= 0) return 'This boundary has no measurable area.';
  } catch {
    return 'This boundary is not a valid polygon.';
  }

  let farm: turf.Feature<turf.Polygon>;
  try {
    farm = makePolygon(farmCoordinates);
  } catch {
    return 'The farm boundary is not valid.';
  }
  if (!turf.booleanWithin(candidate, farm)) return 'Keep each plot or excluded area inside the farm boundary.';

  const sameKindOverlap = regions.some((region) => {
    if (region.id === currentRegionId || region.kind !== kind || region.coordinates.length < 3) return false;
    try {
      const existing = makePolygon(region.coordinates);
      return turf.booleanOverlap(candidate, existing)
        || turf.booleanContains(candidate, existing)
        || turf.booleanContains(existing, candidate);
    } catch {
      return false;
    }
  });
  if (sameKindOverlap) {
    return kind === 'excluded'
      ? 'This excluded area overlaps another excluded area.'
      : 'This plot overlaps an existing plot. Edit the plot boundaries so they do not overlap.';
  }

  if (kind === 'excluded') {
    const plots = regions.filter((region) => region.kind === 'plot' && region.coordinates.length >= 3);
    if (plots.length === 0) return 'Create an agricultural plot before adding excluded areas.';
    if (!plots.some((region) => {
      try {
        return turf.booleanWithin(candidate, makePolygon(region.coordinates));
      } catch {
        return false;
      }
    })) return 'Place excluded areas inside a plot boundary.';
  }
  return '';
};

const projectMercator = (point: GeoPoint) => {
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.latitude)) * Math.PI / 180;
  return {
    x: 6_378_137 * point.longitude * Math.PI / 180,
    y: 6_378_137 * Math.log(Math.tan(Math.PI / 4 + latitude / 2)),
  };
};

const unprojectMercator = (x: number, y: number): GeoPoint => ({
  longitude: x / 6_378_137 * 180 / Math.PI,
  latitude: (2 * Math.atan(Math.exp(y / 6_378_137)) - Math.PI / 2) * 180 / Math.PI,
});

export const generatePlantingPositions = (
  plot: LandUseRegion,
  plans: PlantingPlan[],
  regions: LandUseRegion[],
) => {
  if (plot.kind !== 'plot' || plot.coordinates.length < 3) return [] as GeoPoint[];
  const plan = plans.find((entry) => entry.plotId === plot.id);
  if (!plan || !Number.isFinite(plan.spacingMeters) || plan.spacingMeters <= 0) return [] as GeoPoint[];

  let plotPolygon: turf.Feature<turf.Polygon>;
  try {
    plotPolygon = makePolygon(plot.coordinates);
  } catch {
    return [] as GeoPoint[];
  }
  const obstacles = regions
    .filter((region) => (region.kind === 'excluded' && region.coordinates.length >= 3)
      || (region.kind === 'irrigation' && region.coordinates.length >= 2))
    .flatMap((region) => {
      try {
        if (region.kind === 'irrigation') {
          const line = turf.lineString(region.coordinates.map((point) => [point.longitude, point.latitude]));
          return [turf.buffer(line, 1.5, { units: 'meters' })];
        }
        return [makePolygon(region.coordinates)];
      } catch {
        return [];
      }
    });

  const projected = plot.coordinates.map(projectMercator);
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const spacing = plan.spacingMeters;
  const footprintRadiusKm = Math.max(plan.safetyMarginMeters, 0.1) / 1000;
  const positions: GeoPoint[] = [];

  for (let y = minY + spacing / 2; y <= maxY; y += spacing) {
    for (let x = minX + spacing / 2; x <= maxX; x += spacing) {
      const point = unprojectMercator(x, y);
      const turfPoint = turf.point([point.longitude, point.latitude]);
      if (!turf.booleanPointInPolygon(turfPoint, plotPolygon)) continue;
      const footprint = turf.circle(turfPoint, footprintRadiusKm, { steps: 8, units: 'kilometers' });
      if (!turf.booleanWithin(footprint, plotPolygon)) continue;
      if (obstacles.some((obstacle) => !turf.booleanDisjoint(footprint, obstacle))) continue;
      positions.push(point);
      if (positions.length >= 5000) return positions;
    }
  }
  return positions;
};
