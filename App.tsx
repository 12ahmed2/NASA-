import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as turf from '@turf/turf';
import {
  ArrowLeft,
  Camera,
  Check,
  CirclePlus,
  Compass,
  Edit3,
  Globe,
  LayoutGrid,
  MapPin,
  PencilLine,
  Plus,
  Trash2,
  House,
  Settings,
  ChevronRight,
  Undo2,
  X,
  Layers3,
  Leaf,
  Route as RouteIcon,
  Droplets,
  Building2,
  Expand,
  Minimize2,
  RotateCcw,
  Ruler,
  FlaskConical,
  CalendarDays,
  Wheat,
  TestTube2,
  Database,
  CircleAlert,
  CheckCircle2,
} from 'lucide-react';
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import FarmMap, { type FarmBoundary, type FarmLocation, type GeoPoint, type MapTool, type MapViewType } from './FarmMap';
import FarmDigitalTwin, { getFarmSceneSize, type ImageryState, type SatelliteProvider } from './FarmDigitalTwin';
import { getCropRecommendations } from './cropRecommendations';
import {
  validateLandUseRegion,
  type ExcludedAreaType,
  type LandUseRegion,
  type PlantingPlan,
} from './landUse';
import {
  deleteProcessedImagery,
  loadProcessedImagery,
  saveProcessedImagery,
  type GeographicImageBounds,
} from './processedImagery';
import { calculateWaterBalance, type FarmScenario, type ScenarioCrop } from './scenarioModel';

type User = {
  id: string;
  name: string;
  email: string;
};

type Point = GeoPoint;

type World = {
  id: string;
  name: string;
  ownerId: string;
  location: FarmLocation;
  mapType?: MapViewType;
  boundary: FarmBoundary;
  areaSquareMeters: number;
  areaFeddans: number;
  areaEntryUnit?: AreaEntryUnit;
  areaEntryValue?: number;
  landUseRegions?: LandUseRegion[];
  plantingPlans?: PlantingPlan[];
  processedImagery?: { fileName: string; bounds: GeographicImageBounds };
  scenarios?: FarmScenario[];
  createdAt: string;
};

type AreaEntryUnit = 'feddan' | 'squareMeters';

const LEGACY_USER_STORAGE_KEY = 'soldoc-current-user';
const WORLD_STORAGE_PREFIX = 'soldoc-worlds-';
const LOCAL_FARMER: User = { id: 'local-farmer', name: 'Farmer', email: '' };
const mapTilerApiKey = import.meta.env.VITE_MAPTILER_API_KEY?.trim() ?? '';
const mapboxAccessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim() ?? '';
const IMAGERY_PROVIDER_SESSION_KEY = 'soldoc-imagery-provider';
const DEFAULT_LOCATION: FarmLocation = {
  latitude: 26.8206,
  longitude: 30.8025,
  formattedAddress: 'Egypt',
};

const formatNumber = (value: number) => new Intl.NumberFormat('en-US').format(value);

const getCurrentUser = (): User => {
  try {
    const raw = localStorage.getItem(LEGACY_USER_STORAGE_KEY);
    if (!raw) return LOCAL_FARMER;
    const legacyUser = JSON.parse(raw) as Partial<User>;
    if (typeof legacyUser.id !== 'string' || typeof legacyUser.name !== 'string') return LOCAL_FARMER;
    return { id: legacyUser.id, name: legacyUser.name, email: legacyUser.email ?? '' };
  } catch {
    return LOCAL_FARMER;
  }
};

const getWorldsForUser = (ownerId: string): World[] => {
  try {
    const raw = localStorage.getItem(`${WORLD_STORAGE_PREFIX}${ownerId}`);
    if (!raw) return [];
    const stored = JSON.parse(raw) as Array<World & { boundary: FarmBoundary | Point[]; location: FarmLocation | Point }>;
    return stored.map((world) => {
      const coordinates = Array.isArray(world.boundary) ? world.boundary : world.boundary.coordinates;
      const location = world.location as FarmLocation;
      const areaSquareMeters = world.areaSquareMeters > 0 ? world.areaSquareMeters : getLandArea(coordinates);
      return {
        ...world,
        landUseRegions: world.landUseRegions ?? [],
        plantingPlans: world.plantingPlans ?? [],
        scenarios: world.scenarios ?? [],
        mapType: world.mapType ?? 'satellite',
        areaEntryUnit: world.areaEntryUnit ?? 'squareMeters',
        areaEntryValue: world.areaEntryValue ?? areaSquareMeters,
        location: {
          ...location,
          formattedAddress: location.formattedAddress || formatLocationLabel(location),
        },
        boundary: {
          coordinates,
          areaSquareMeters,
          areaFeddans: world.areaFeddans ?? areaSquareMeters / 4200,
        },
      };
    });
  } catch {
    return [];
  }
};

const saveWorldsForUser = (ownerId: string, worlds: World[]) => {
  localStorage.setItem(`${WORLD_STORAGE_PREFIX}${ownerId}`, JSON.stringify(worlds));
};

const upsertWorld = (world: World) => {
  const currentUser = getCurrentUser();
  const worlds = getWorldsForUser(currentUser.id);
  const next = [...worlds.filter((entry) => entry.id !== world.id), world];
  saveWorldsForUser(currentUser.id, next);
};

const saveWorldToStorage = (world: World) => {
  const currentUser = getCurrentUser();
  const worlds = getWorldsForUser(currentUser.id);
  saveWorldsForUser(currentUser.id, [...worlds, world]);
};

const deleteWorldFromStorage = async (worldId: string) => {
  const currentUser = getCurrentUser();
  const existingWorlds = getWorldsForUser(currentUser.id);
  if (existingWorlds.some((world) => world.id === worldId && world.processedImagery)) {
    await deleteProcessedImagery(worldId);
  }
  const worlds = existingWorlds.filter((world) => world.id !== worldId);
  saveWorldsForUser(currentUser.id, worlds);
};

const updateWorldName = (worldId: string, newName: string) => {
  const currentUser = getCurrentUser();
  const worlds = getWorldsForUser(currentUser.id).map((world) =>
    world.id === worldId ? { ...world, name: newName.trim() || world.name } : world,
  );
  saveWorldsForUser(currentUser.id, worlds);
};

const getLandArea = (points: Point[]) => {
  if (points.length < 3) return 0;
  const closed = [...points.map((p) => [p.longitude, p.latitude]), [points[0].longitude, points[0].latitude]];
  try {
    const polygon = turf.polygon([closed]);
    return turf.area(polygon);
  } catch {
    return 0;
  }
};

const getLinearLengthMeters = (points: Point[]) => {
  if (points.length < 2) return 0;
  try {
    return turf.length(turf.lineString(points.map((point) => [point.longitude, point.latitude])), { units: 'meters' });
  } catch {
    return 0;
  }
};

const validateBoundary = (points: Point[]) => {
  if (points.length < 3) return { valid: false, message: 'Add at least three boundary points.', area: 0 };
  if (points.some((point) => !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
    || point.latitude < -90 || point.latitude > 90 || point.longitude < -180 || point.longitude > 180)) {
    return { valid: false, message: 'One or more boundary points have invalid coordinates.', area: 0 };
  }

  const samePoint = (first: Point, second: Point) =>
    first.latitude === second.latitude && first.longitude === second.longitude;
  for (let index = 1; index < points.length; index += 1) {
    if (samePoint(points[index - 1], points[index])) {
      return { valid: false, message: 'Remove duplicate consecutive boundary points.', area: 0 };
    }
  }
  if (samePoint(points[0], points[points.length - 1])) {
    return { valid: false, message: 'The boundary closes automatically; remove the repeated first point.', area: 0 };
  }
  const distinct = new Set(points.map((point) => `${point.latitude},${point.longitude}`));
  if (distinct.size < 3) return { valid: false, message: 'Add at least three distinct boundary points.', area: 0 };

  const ring = [...points.map((point) => [point.longitude, point.latitude]), [points[0].longitude, points[0].latitude]];
  try {
    const polygon = turf.polygon([ring]);
    if (turf.kinks(turf.cleanCoords(polygon)).features.length > 0) {
      return { valid: false, message: 'The boundary crosses itself. Move the points so the outline does not intersect.', area: 0 };
    }
    const area = turf.area(polygon);
    if (!Number.isFinite(area) || area <= 0) return { valid: false, message: 'This boundary has no measurable area.', area: 0 };
    return { valid: true, message: '', area };
  } catch {
    return { valid: false, message: 'This boundary is not a valid polygon. Adjust the points and try again.', area: 0 };
  }
};

const formatAreaDisplay = (areaSquareMeters: number) => {
  const feddans = areaSquareMeters / 4200;
  return {
    areaLabel: `${formatNumber(Math.round(areaSquareMeters))} m²`,
    feddanLabel: `${feddans.toFixed(2)} Feddans`,
  };
};

const formatLocationLabel = (location: FarmLocation | Point) =>
  ('formattedAddress' in location && location.formattedAddress)
    ? location.formattedAddress
    : `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;

const formatLocationLabelFromFeature = (feature: any) => {
  const properties = feature?.properties ?? {};
  return [
    properties.name,
    properties.street,
    properties.city ?? properties.locality,
    properties.state,
    properties.country,
  ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(', ');
};

function Logo() {
  return (
    <div className="logo-badge">
      <div className="hero-dot" />
      <span>SOLDOC</span>
    </div>
  );
}

function Header({ title }: { title: string }) {
  return (
    <header className="site-header flex items-center justify-between px-6 py-5 border-b border-[rgba(139,203,136,0.15)] bg-[rgba(16,24,19,0.8)]">
      <div className="flex items-center gap-3">
        <Logo />
        <span className="text-sm uppercase tracking-[0.2em] text-[rgba(243,240,230,0.7)]">Virtual Farm</span>
      </div>
      <h1 className="text-lg font-semibold text-beige">{title}</h1>
    </header>
  );
}

function DashboardPage({ currentUser }: { currentUser: User }) {
  const navigate = useNavigate();
  const [worlds, setWorlds] = useState<World[]>([]);

  useEffect(() => {
    setWorlds(getWorldsForUser(currentUser.id));
  }, [currentUser.id]);

  const handleDelete = async (worldId: string) => {
    try {
      await deleteWorldFromStorage(worldId);
      setWorlds((current) => current.filter((world) => world.id !== worldId));
    } catch (deleteError) {
      window.alert(deleteError instanceof Error ? deleteError.message : 'Could not remove the farm and its stored image.');
    }
  };

  const handleRename = async (worldId: string) => {
    const nextName = window.prompt('Update farm name', 'My Virtual Farm');
    if (!nextName) return;
    updateWorldName(worldId, nextName);
    setWorlds((current) => current.map((world) => (world.id === worldId ? { ...world, name: nextName.trim() || world.name } : world)));
  };

  return (
    <div className="app-shell dashboard-page">
      <aside className="dashboard-sidebar">
        <div className="sidebar-brand"><Logo /><span>Virtual Farm</span></div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <span className="sidebar-label">WORKSPACE</span>
          <button className="sidebar-link active"><LayoutGrid size={18} />Dashboard</button>
          <button className="sidebar-link" onClick={() => navigate('/create-world')}><Plus size={18} />Create New World</button>
          <button className="sidebar-link" onClick={() => document.getElementById('my-farms')?.scrollIntoView({ behavior: 'smooth' })}><House size={18} />My Farms</button>
          <span className="sidebar-label sidebar-label-spaced">PREFERENCES</span>
          <button className="sidebar-link" onClick={() => window.alert('Settings will be available in a future update.')}><Settings size={18} />Settings</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note"><span className="sidebar-note-icon">✦</span><p>Your land, made visible.</p></div>
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-topbar">
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>Dashboard</strong></div>
          <div className="topbar-profile"><span className="language-chip">◎ EN⌄</span><span className="profile-avatar">{currentUser.name.charAt(0).toUpperCase()}</span><strong>{currentUser.name}</strong><span className="profile-chevron">⌄</span></div>
        </header>

        <main className="dashboard-content">
        <section className="dashboard-hero">
          <div className="dashboard-hero-landscape" aria-hidden="true">
            <div className="hero-sun" /><div className="hero-hills" /><div className="hero-tree-line" /><div className="hero-crop-rows" />
          </div>
          <div className="dashboard-hero-copy">
            <p className="hero-kicker">YOUR LAND, REIMAGINED</p>
            <h2>Welcome to your farm.</h2>
            <p>Turn your land into a virtual farm and<br className="desktop-break" /> explore its potential.</p>
            <button className="primary-button flex items-center gap-2" onClick={() => navigate('/create-world')}>
              <Plus size={18} />Create New World
            </button>
          </div>
        </section>

        <section className="dashboard-farms" id="my-farms">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <p className="section-eyebrow">YOUR COLLECTION</p>
              <h3 className="mt-1 text-2xl font-semibold text-beige">My Farms</h3>
            </div>
            <button className="view-all-button" onClick={() => navigate('/create-world')}>Create another <ChevronRight size={15} /></button>
          </div>

          {worlds.length === 0 ? (
            <div className="farm-empty-state">
              <div className="empty-icon"><House size={23} /></div>
              <div><h4>Your agricultural journey starts here.</h4><p>Create your first virtual farm and explore your land in a new way.</p></div>
              <button className="primary-button" onClick={() => navigate('/create-world')}>Create your first farm <ChevronRight size={16} /></button>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {worlds.map((world) => {
                const { areaLabel, feddanLabel } = formatAreaDisplay(world.areaSquareMeters);
                return (
                  <div key={world.id} className="farm-card">
                    <div className="farm-card-art"><div className="farm-card-hills" /><div className="farm-card-rows" /></div>
                    <div className="farm-card-body">
                      <h4>{world.name}</h4>
                      <div className="farm-meta"><MapPin size={13} /><span>{formatLocationLabel(world.location)}</span></div>
                      <div className="farm-meta"><LayoutGrid size={13} /><span>{feddanLabel.replace('Equivalent to: ', '')}</span><span className="area-secondary">{areaLabel}</span></div>
                      <div className="farm-card-actions">
                        <button className="farm-open-button" onClick={() => navigate(`/world/${world.id}`)}>Open</button>
                        <button className="farm-icon-button" aria-label={`Edit ${world.name}`} onClick={() => handleRename(world.id)}><PencilLine size={15} /></button>
                        <button className="farm-icon-button delete" aria-label={`Delete ${world.name}`} onClick={() => handleDelete(world.id)}><Trash2 size={15} /></button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        </main>
      </div>
    </div>
  );
}

function CreateWorldPage({ currentUser }: { currentUser: User }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedWorldId = searchParams.get('edit');
  const [step, setStep] = useState(1);
  const [selectedLocation, setSelectedLocation] = useState<FarmLocation>(DEFAULT_LOCATION);
  const [mapType, setMapType] = useState<MapViewType>('satellite');
  const [boundary, setBoundary] = useState<Point[]>([]);
  const [areaEntryUnit, setAreaEntryUnit] = useState<AreaEntryUnit>('feddan');
  const [areaEntryValue, setAreaEntryValue] = useState('');
  const [worldName, setWorldName] = useState('My Virtual Farm');
  const [tool, setTool] = useState<MapTool>('location');
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [editingWorldId, setEditingWorldId] = useState<string | null>(null);
  const [landUseRegions, setLandUseRegions] = useState<LandUseRegion[]>([]);
  const [plantingPlans, setPlantingPlans] = useState<PlantingPlan[]>([]);
  const [processedImageryMetadata, setProcessedImageryMetadata] = useState<World['processedImagery']>(undefined);
  const [processedImageryBlob, setProcessedImageryBlob] = useState<Blob | null>(null);
  const [processedImageryBounds, setProcessedImageryBounds] = useState<GeographicImageBounds>({
    west: 0,
    south: 0,
    east: 0,
    north: 0,
  });
  const [processedImageryRemoved, setProcessedImageryRemoved] = useState(false);
  const [regionKind, setRegionKind] = useState<LandUseRegion['kind']>('plot');
  const [excludedAreaType, setExcludedAreaType] = useState<ExcludedAreaType>('road');
  const [regionName, setRegionName] = useState('');
  const [draftRegionId, setDraftRegionId] = useState<string | null>(null);
  const [draftRegionCoordinates, setDraftRegionCoordinates] = useState<Point[]>([]);
  const [digitizerMode, setDigitizerMode] = useState<'idle' | 'drawing' | 'editing'>('idle');

  useEffect(() => {
    if (!requestedWorldId) return;
    const savedWorld = getWorldsForUser(currentUser.id).find((world) => world.id === requestedWorldId);
    if (!savedWorld) {
      setError('That saved farm could not be found.');
      return;
    }
    setEditingWorldId(savedWorld.id);
    setSelectedLocation(savedWorld.location);
    setMapType(savedWorld.mapType ?? 'satellite');
    setBoundary(savedWorld.boundary.coordinates);
    setAreaEntryUnit(savedWorld.areaEntryUnit ?? 'squareMeters');
    setAreaEntryValue(String(savedWorld.areaEntryValue ?? savedWorld.areaSquareMeters));
    setLandUseRegions(savedWorld.landUseRegions ?? []);
    setPlantingPlans(savedWorld.plantingPlans ?? []);
    setProcessedImageryMetadata(savedWorld.processedImagery);
    if (savedWorld.processedImagery) setProcessedImageryBounds(savedWorld.processedImagery.bounds);
    setWorldName(savedWorld.name);
    setTool('idle');
    setStep(2);
  }, [currentUser.id, requestedWorldId]);

  useEffect(() => {
    if (!editingWorldId || !processedImageryMetadata || processedImageryBlob) return;
    let active = true;
    void loadProcessedImagery(editingWorldId)
      .then((blob) => {
        if (!active) return;
        if (!blob) {
          setError('The processed image metadata exists, but its local image file is missing. Re-upload the image.');
          setProcessedImageryMetadata(undefined);
          return;
        }
        setProcessedImageryBlob(blob);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load the processed image.');
      });
    return () => { active = false; };
  }, [editingWorldId, processedImageryBlob, processedImageryMetadata]);

  const boundaryValidation = useMemo(() => validateBoundary(boundary), [boundary]);
  const enteredArea = areaEntryValue.trim() === '' ? Number.NaN : Number(areaEntryValue);
  const hasValidEnteredArea = Number.isFinite(enteredArea) && enteredArea > 0;
  const areaSquareMeters = hasValidEnteredArea
    ? areaEntryUnit === 'feddan' ? enteredArea * 4200 : enteredArea
    : 0;
  const areaSummary = formatAreaDisplay(areaSquareMeters);
  const recommendationResult = useMemo(() => getCropRecommendations({
    location: selectedLocation,
    areaSquareMeters,
    plots: landUseRegions
      .filter((region) => region.kind === 'plot')
      .map((region) => ({
        id: region.id,
        name: region.name,
        areaSquareMeters: getLandArea(region.coordinates),
      })),
  }), [areaSquareMeters, landUseRegions, selectedLocation]);

  const changeAreaEntryUnit = (nextUnit: AreaEntryUnit) => {
    if (nextUnit === areaEntryUnit) return;
    if (hasValidEnteredArea) {
      const convertedValue = areaEntryUnit === 'feddan' ? enteredArea * 4200 : enteredArea / 4200;
      setAreaEntryValue(nextUnit === 'feddan' ? convertedValue.toFixed(6) : convertedValue.toFixed(2));
    }
    setAreaEntryUnit(nextUnit);
    setError('');
  };

  const handleLocationChange = (next: FarmLocation) => {
    setSelectedLocation(next);
    setError('');
  };

  const handleUseMyLocation = () => {
    if (!navigator.geolocation) {
      setError('Location access is not available in this browser. Search for a place or click the map instead.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          formattedAddress: 'Current location',
        };
        setSelectedLocation(next);
        const params = new URLSearchParams({ lat: String(next.latitude), lon: String(next.longitude) });
        void fetch(`https://photon.komoot.io/reverse?${params.toString()}`)
          .then((response) => response.ok ? response.json() : Promise.reject(new Error('Reverse lookup failed')))
          .then((result) => {
            const suggestion = result.features?.[0] ? formatLocationLabelFromFeature(result.features[0]) : '';
            if (suggestion) setSelectedLocation({ ...next, formattedAddress: suggestion });
          })
          .catch(() => undefined);
        setError('');
      },
      (geolocationError) => {
        setError(geolocationError.code === geolocationError.PERMISSION_DENIED
          ? 'Location permission was denied. Search for your farm or select its location on the map.'
          : 'Your current location could not be determined. Search for your farm or select it on the map.');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const updateBoundary = (coordinates: Point[]) => {
    setBoundary(coordinates);
    setError('');
  };

  const nextStep = async () => {
    if (step === 1) {
      setTool('idle');
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!boundaryValidation.valid) {
        setError(boundaryValidation.message);
        return;
      }
      if (!hasValidEnteredArea) {
        setError('Enter a land area greater than zero in feddans or square meters.');
        return;
      }
      setError('');
      setTool('idle');
      setStep(3);
      return;
    }
    if (step === 3) {
      if (digitizerMode !== 'idle') {
        setError('Finish or cancel the current plot or excluded-area drawing before continuing.');
        return;
      }
      setError('');
      setStep(4);
      return;
    }
    if (step === 4) {
      if (digitizerMode !== 'idle') {
        setError('Finish or cancel the current plot or excluded-area drawing before saving the farm.');
        return;
      }
      if (!boundaryValidation.valid) {
        setError(boundaryValidation.message);
        return;
      }
      if (!hasValidEnteredArea) {
        setError('Enter a land area greater than zero in feddans or square meters.');
        return;
      }

      const world: World = {
        id: editingWorldId ?? `world_${Date.now()}`,
        name: worldName.trim() || 'My Virtual Farm',
        ownerId: currentUser.id,
        location: selectedLocation,
        mapType,
        areaEntryUnit,
        areaEntryValue: enteredArea,
        landUseRegions,
        plantingPlans,
        processedImagery: processedImageryBlob ? {
          fileName: processedImageryMetadata?.fileName ?? 'processed-image',
          bounds: processedImageryBounds,
        } : undefined,
        boundary: {
          coordinates: boundary,
          areaSquareMeters,
          areaFeddans: areaSquareMeters / 4200,
        },
        areaSquareMeters,
        areaFeddans: areaSquareMeters / 4200,
        createdAt: editingWorldId
          ? getWorldsForUser(currentUser.id).find((saved) => saved.id === editingWorldId)?.createdAt ?? new Date().toISOString()
          : new Date().toISOString(),
      };

      if (processedImageryBlob) {
        const { west, south, east, north } = processedImageryBounds;
        if (![west, south, east, north].every(Number.isFinite)
          || west >= east || south >= north
          || south < -90 || north > 90 || west < -180 || east > 180) {
          setError('Enter valid west, south, east, and north coordinates for the processed image.');
          return;
        }
        const containsFarm = boundary.every((point) => point.longitude >= west
          && point.longitude <= east
          && point.latitude >= south
          && point.latitude <= north);
        if (!containsFarm) {
          setError('The processed image bounds must contain the complete farm boundary so the overlay stays geographically aligned.');
          return;
        }
      } else if (processedImageryMetadata && !processedImageryRemoved) {
        setError('The processed image is still loading or unavailable. Wait, re-upload it, or remove it before saving.');
        return;
      }

      try {
        if (processedImageryBlob) await saveProcessedImagery(world.id, processedImageryBlob);
        else if (processedImageryRemoved && editingWorldId) await deleteProcessedImagery(editingWorldId);
        if (editingWorldId) upsertWorld(world);
        else saveWorldToStorage(world);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'Could not save this farm. Check browser storage availability.');
        return;
      }
      navigate(`/world/${world.id}`);
    }
  };

  const handleStepChange = (nextStep: number) => {
    setTool(nextStep === 1 ? 'location' : 'idle');
    setStep(nextStep);
    setError('');
  };

  const removeSelectedVertex = () => {
    if (selectedVertex === null) return;
    updateBoundary(boundary.filter((_, index) => index !== selectedVertex));
    setSelectedVertex(null);
  };

  const prepareNewRegion = (kind: LandUseRegion['kind']) => {
    setRegionKind(kind);
    setRegionName(kind === 'plot'
      ? `Plot ${landUseRegions.filter((region) => region.kind === 'plot').length + 1}`
      : kind === 'irrigation'
        ? `Irrigation line ${landUseRegions.filter((region) => region.kind === 'irrigation').length + 1}`
        : 'Road');
    if (kind === 'irrigation') setExcludedAreaType('canal');
    setDraftRegionId(null);
    setDraftRegionCoordinates([]);
    setDigitizerMode('drawing');
    setError('');
  };

  const editRegion = (region: LandUseRegion) => {
    setRegionKind(region.kind);
    setExcludedAreaType(region.excludedType ?? 'other');
    setRegionName(region.name);
    setDraftRegionId(region.id);
    setDraftRegionCoordinates(region.coordinates);
    setDigitizerMode('editing');
    setError('');
  };

  const finishLandUseRegion = () => {
    const regionError = validateLandUseRegion(
      draftRegionCoordinates,
      boundary,
      landUseRegions,
      regionKind,
      draftRegionId ?? undefined,
    );
    if (regionError) {
      setError(regionError);
      return;
    }

    const region: LandUseRegion = {
      id: draftRegionId ?? `region_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: regionName.trim() || (regionKind === 'plot'
        ? 'Agricultural plot'
        : regionKind === 'irrigation'
          ? 'Irrigation line'
          : 'Excluded area'),
      kind: regionKind,
      ...(regionKind === 'excluded' || regionKind === 'irrigation' ? { excludedType: regionKind === 'irrigation' ? 'canal' : excludedAreaType } : {}),
      coordinates: draftRegionCoordinates,
    };
    setLandUseRegions((current) => [...current.filter((entry) => entry.id !== region.id), region]);
    setDraftRegionId(null);
    setDraftRegionCoordinates([]);
    setDigitizerMode('idle');
    setError('');
  };

  const removeLandUseRegion = (regionId: string) => {
    setLandUseRegions((current) => current.filter((region) => region.id !== regionId));
    setPlantingPlans((current) => current.filter((plan) => plan.plotId !== regionId));
    if (draftRegionId === regionId) {
      setDraftRegionId(null);
      setDraftRegionCoordinates([]);
      setDigitizerMode('idle');
    }
  };

  const handleProcessedImageryFile = (file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Use a georeferenced PNG, JPEG, or WebP processed image.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('Processed images must be 20 MB or smaller for reliable local browser storage.');
      return;
    }
    const longitudes = boundary.map((point) => point.longitude);
    const latitudes = boundary.map((point) => point.latitude);
    const bounds = {
      west: Math.min(...longitudes),
      south: Math.min(...latitudes),
      east: Math.max(...longitudes),
      north: Math.max(...latitudes),
    };
    setProcessedImageryBounds(bounds);
    setProcessedImageryMetadata({
      fileName: file.name,
      bounds,
    });
    setProcessedImageryBlob(file);
    setProcessedImageryRemoved(false);
    setError('');
  };

  return (
    <div className="app-shell wizard-page">
      <Header title={editingWorldId ? 'Edit Farm Boundary' : 'Create New World'} />
      <main className="mx-auto max-w-7xl px-4 py-8 md:px-6">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="wizard-progress" aria-label={`Step ${step} of 4`}>
            {['Choose Location', 'Draw Your Land', 'Define Plots', 'Crop Suggestions'].map((label, index) => (
              <div className={`wizard-progress-step ${step === index + 1 ? 'current' : ''} ${step > index + 1 ? 'complete' : ''}`} key={label}>
                <span>{step > index + 1 ? '✓' : index + 1}</span><strong>{label}</strong>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.6fr_0.9fr]">
          <div className="glass-card rounded-[28px] p-5">
            {step === 1 ? (
              <div className="space-y-5">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-[rgba(139,203,136,0.12)] p-2 text-greenLight">
                    <MapPin size={20} />
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-[rgba(243,240,230,0.6)]">Step 1</p>
                    <h3 className="text-2xl font-semibold text-beige">Choose Your Land Location</h3>
                  </div>
                </div>

                <div className="map-location-toolbar">
                  <p>Search for your city, village, address or landmark, or click the map to select a point.</p>
                  <button type="button" className="secondary-button" onClick={handleUseMyLocation}><MapPin size={15} /> Use My Location</button>
                </div>
                <FarmMap
                  location={selectedLocation}
                  boundary={boundary}
                  mapType={mapType}
                  tool="location"
                  selectedVertex={selectedVertex}
                  onLocationChange={handleLocationChange}
                  onBoundaryChange={updateBoundary}
                  onMapTypeChange={setMapType}
                  onToolChange={setTool}
                  onSelectedVertexChange={setSelectedVertex}
                />

                <div className="map-info-card">
                  <p className="text-sm text-[rgba(243,240,230,0.7)]">Selected location</p>
                  <p className="mt-2 text-lg font-semibold text-beige">{selectedLocation.formattedAddress}</p>
                  <p className="mt-1 text-xs text-[rgba(243,240,230,0.65)]">{selectedLocation.latitude.toFixed(6)}, {selectedLocation.longitude.toFixed(6)}</p>
                </div>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-5">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-[rgba(139,203,136,0.12)] p-2 text-greenLight">
                    <PencilLine size={20} />
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-[rgba(243,240,230,0.6)]">Step 2</p>
                    <h3 className="text-2xl font-semibold text-beige">Draw Your Land</h3>
                  </div>
                </div>

                <div className="boundary-toolbar" aria-label="Boundary drawing tools">
                  <button type="button" className={tool === 'drawing' ? 'active' : ''} onClick={() => { setError(''); setTool('drawing'); }}>
                    <PencilLine size={15} />Start Drawing
                  </button>
                  <button type="button" className={tool === 'drawing' ? 'active' : ''} onClick={() => {
                    setTool('idle');
                    if (boundary.length < 3) setError('Add at least three boundary points before finishing.');
                    else if (!boundaryValidation.valid) setError(boundaryValidation.message);
                    else setError('');
                  }}>
                    <Check size={15} />Finish Drawing
                  </button>
                  <button type="button" className={tool === 'editing' ? 'active' : ''} onClick={() => { setError(''); setTool('editing'); }}>
                    <Edit3 size={15} />Edit Boundary
                  </button>
                  <button type="button" disabled={selectedVertex === null} onClick={removeSelectedVertex}>
                    <X size={15} />Remove Selected
                  </button>
                  <button type="button" onClick={() => {
                    updateBoundary([]);
                    setSelectedVertex(null);
                    setTool('idle');
                  }}>
                    <Trash2 size={15} />Clear Boundary
                  </button>
                  <button type="button" disabled={!boundary.length} onClick={() => {
                    updateBoundary(boundary.slice(0, -1));
                    setSelectedVertex(null);
                  }}>
                    <Undo2 size={15} />Undo Last Point
                  </button>
                </div>

                {tool === 'drawing' || tool === 'editing' ? (
                  <div className="map-mode-hint">
                    {tool === 'drawing'
                      ? 'Drawing mode: click the map to add points. Click the first point or Finish Drawing to close.'
                      : 'Edit mode: drag vertices to move them, click a yellow midpoint to add an intermediate vertex, right-click a vertex to delete it, or click the map to append a point.'}
                  </div>
                ) : null}

                <FarmMap
                  location={selectedLocation}
                  boundary={boundary}
                  mapType={mapType}
                  tool={tool}
                  selectedVertex={selectedVertex}
                  onLocationChange={handleLocationChange}
                  onBoundaryChange={updateBoundary}
                  onMapTypeChange={setMapType}
                  onToolChange={setTool}
                  onSelectedVertexChange={setSelectedVertex}
                />

                <section className="area-entry-card" aria-labelledby="area-entry-title">
                  <div>
                    <h4 id="area-entry-title">Enter Your Land Area</h4>
                    <p>Draw the land shape on the map, then enter its area. Your entered area is saved. One Egyptian feddan equals 4,200 m².</p>
                  </div>
                  <div className="area-entry-fields">
                    <label className="sr-only" htmlFor="land-area-value">Land area value</label>
                    <input
                      id="land-area-value"
                      className="input-shell"
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={areaEntryValue}
                      onChange={(event) => {
                        setAreaEntryValue(event.target.value);
                        setError('');
                      }}
                      placeholder={areaEntryUnit === 'feddan' ? 'Enter feddans' : 'Enter square meters'}
                    />
                    <label className="sr-only" htmlFor="land-area-unit">Area unit</label>
                    <select
                      id="land-area-unit"
                      className="input-shell"
                      value={areaEntryUnit}
                      onChange={(event) => changeAreaEntryUnit(event.target.value as AreaEntryUnit)}
                    >
                      <option value="feddan">Feddans</option>
                      <option value="squareMeters">Square meters (m²)</option>
                    </select>
                  </div>
                  <div className="area-entry-results" aria-live="polite">
                    <div>
                      <span>Egyptian feddans</span>
                      <strong>{hasValidEnteredArea ? areaSummary.feddanLabel : '— Feddans'}</strong>
                    </div>
                    <div>
                      <span>Square meters</span>
                      <strong>{hasValidEnteredArea ? areaSummary.areaLabel : '— m²'}</strong>
                    </div>
                  </div>
                  {boundaryValidation.valid ? (
                    <p className="area-entry-measured">
                      Approximate area from the drawn boundary: {formatAreaDisplay(boundaryValidation.area).areaLabel}.
                      {' '}This map estimate is for reference; your entered area is saved.
                    </p>
                  ) : null}
                </section>

                {boundary.length > 0 && !boundaryValidation.valid
                  ? <p className="boundary-validation-message">{boundaryValidation.message}</p>
                  : <p className="map-mode-hint">Boundary points: {boundary.length}. Area updates as you draw or edit.</p>}
              </div>
            ) : null}

            {step === 3 ? (
              <div className="space-y-5">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-[rgba(139,203,136,0.12)] p-2 text-greenLight">
                    <Globe size={20} />
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-[rgba(243,240,230,0.6)]">Step 3</p>
                    <h3 className="text-2xl font-semibold text-beige">Configure Plots and Land Features</h3>
                  </div>
                </div>

                <section className="land-use-editor" aria-labelledby="land-use-title">
                  <div className="land-use-editor-heading">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em]">Manual land-use map</p>
                      <h4 id="land-use-title">Define verified plots, irrigation, and obstacles</h4>
                    </div>
                    <span>{landUseRegions.filter((region) => region.kind === 'plot').length} plots</span>
                  </div>
                  <p className="land-use-editor-note">
                    Satellite imagery is not automatically classified. Only plot boundaries that you manually verify are plantable.
                      Draw irrigation lines across the whole farm and mark roads, paths, canals, buildings, and water as excluded areas.
                  </p>

                  <div className="land-use-drawing-toolbar">
                    <button type="button" onClick={() => prepareNewRegion('plot')}>Draw agricultural plot</button>
                    <button type="button" onClick={() => prepareNewRegion('excluded')} disabled={!landUseRegions.some((region) => region.kind === 'plot')}>Mark excluded area</button>
                    <button type="button" onClick={() => prepareNewRegion('irrigation')}>Draw irrigation line</button>
                    <button type="button" onClick={finishLandUseRegion} disabled={digitizerMode === 'idle'}>Finish & save region</button>
                    <button type="button" onClick={() => { setDigitizerMode('idle'); setDraftRegionCoordinates([]); setDraftRegionId(null); }} disabled={digitizerMode === 'idle'}>Cancel</button>
                    <button type="button" onClick={() => setDraftRegionCoordinates((points) => points.slice(0, -1))} disabled={digitizerMode === 'idle' || !draftRegionCoordinates.length}>Undo point</button>
                  </div>

                  {digitizerMode !== 'idle' ? (
                    <div className="land-use-draft-fields">
                      <label>
                        Region name
                        <input value={regionName} onChange={(event) => setRegionName(event.target.value)} />
                      </label>
                      {regionKind === 'excluded' ? (
                        <label>
                          Obstacle type
                          <select value={excludedAreaType} onChange={(event) => setExcludedAreaType(event.target.value as ExcludedAreaType)}>
                            <option value="road">Road</option>
                            <option value="path">Path</option>
                            <option value="canal">Irrigation canal</option>
                            <option value="building">Building</option>
                            <option value="water">Water body</option>
                            <option value="other">Other non-plantable area</option>
                          </select>
                        </label>
                      ) : null}
                      <p>
                        {regionKind === 'irrigation'
                          ? 'Draw a connected main or lateral irrigation route across the farm. It is not limited to one plot.'
                          : 'Click the map to add boundary points. In edit mode, drag a vertex or right-click it to remove it.'}
                        {' '}Vertices: {draftRegionCoordinates.length}.
                      </p>
                    </div>
                  ) : null}

                  <FarmMap
                    location={selectedLocation}
                    boundary={boundary}
                    mapType={mapType}
                    tool="idle"
                    selectedVertex={selectedVertex}
                    onLocationChange={handleLocationChange}
                    onBoundaryChange={updateBoundary}
                    onMapTypeChange={setMapType}
                    onToolChange={setTool}
                    onSelectedVertexChange={setSelectedVertex}
                    landUseRegions={landUseRegions.filter((region) => region.id !== draftRegionId)}
                    digitizer={{
                      mode: digitizerMode,
                      coordinates: draftRegionCoordinates,
                      kind: regionKind,
                      onChange: setDraftRegionCoordinates,
                    }}
                  />

                  <div className="land-use-region-list">
                    {landUseRegions.length ? landUseRegions.map((region) => {
                      const regionMeta = region.kind === 'plot'
                        ? { label: 'Verified plantable plot', value: formatAreaDisplay(getLandArea(region.coordinates)).areaLabel }
                        : region.kind === 'irrigation'
                          ? { label: 'Irrigation network', value: `${formatNumber(Math.round(getLinearLengthMeters(region.coordinates)))} m` }
                          : { label: `Excluded: ${region.excludedType ?? 'other'}`, value: formatAreaDisplay(getLandArea(region.coordinates)).areaLabel };

                      return (
                        <div key={region.id} className={`land-use-region-row ${region.kind}`}>
                          <span>
                            <strong>{region.name}</strong>
                            <small>{regionMeta.label} · {regionMeta.value}</small>
                          </span>
                          <div>
                            <button type="button" onClick={() => editRegion(region)}>Edit</button>
                            <button type="button" onClick={() => removeLandUseRegion(region.id)}>Remove</button>
                          </div>
                        </div>
                      );
                    }) : <p>No plots are marked. The entire farm remains non-plantable until you draw and save a verified plot.</p>}
                  </div>

                  <div className="processed-imagery-import">
                    <h5>Optional externally processed clean image</h5>
                    <p>
                      SOLDOC does not automatically identify or erase vegetation. Upload an image processed by a trusted
                      external GIS or inpainting workflow; the original live satellite imagery is retained underneath.
                      Enter the image's true geographic bounds to align it over this farm.
                    </p>
                    <label className="processed-imagery-file">
                      <span>{processedImageryMetadata?.fileName ?? 'Choose processed PNG, JPEG, or WebP (max 20 MB)'}</span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(event) => handleProcessedImageryFile(event.target.files?.[0])}
                      />
                    </label>
                    {processedImageryBlob ? (
                      <div className="processed-imagery-bounds">
                        {([
                          ['west', 'West longitude'],
                          ['south', 'South latitude'],
                          ['east', 'East longitude'],
                          ['north', 'North latitude'],
                        ] as const).map(([field, label]) => (
                          <label key={field}>
                            {label}
                            <input
                              type="number"
                              step="any"
                              value={processedImageryBounds[field]}
                              onChange={(event) => setProcessedImageryBounds((current) => ({
                                ...current,
                                [field]: Number(event.target.value),
                              }))}
                            />
                          </label>
                        ))}
                        <button type="button" onClick={() => {
                          setProcessedImageryBlob(null);
                          setProcessedImageryMetadata(undefined);
                          setProcessedImageryRemoved(true);
                        }}>Remove processed image</button>
                      </div>
                    ) : null}
                    {processedImageryMetadata && !processedImageryBlob ? <p>Loading saved processed image…</p> : null}
                  </div>
                </section>

                <div className="space-y-4">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-[rgba(243,240,230,0.82)]">World name</label>
                    <input className="input-shell" value={worldName} onChange={(event) => setWorldName(event.target.value)} placeholder="My Virtual Farm" />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-[rgba(243,240,230,0.82)]">Selected location</label>
                    <input className="input-shell" value={selectedLocation.formattedAddress} readOnly />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-[rgba(243,240,230,0.82)]">Entered land area</label>
                    <input
                      className="input-shell"
                      value={hasValidEnteredArea ? `${areaSummary.feddanLabel} (${areaSummary.areaLabel})` : 'No area entered'}
                      readOnly
                    />
                  </div>
                </div>

                <div className="rounded-[24px] border border-[rgba(139,203,136,0.2)] bg-[linear-gradient(135deg,rgba(22,61,42,0.72),rgba(16,24,19,0.9))] p-5">
                  <p className="text-xs uppercase tracking-[0.24em] text-[rgba(243,240,230,0.65)]">Land Boundary Preview</p>
                  <div className="mt-4 grid gap-2 text-sm text-[rgba(243,240,230,0.78)]">
                    <div className="flex items-center justify-between rounded-xl bg-[rgba(16,24,19,0.45)] px-3 py-2">
                      <span>World Name</span>
                      <strong>{worldName || 'My Virtual Farm'}</strong>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-[rgba(16,24,19,0.45)] px-3 py-2">
                      <span>Location</span>
                      <strong>{selectedLocation.formattedAddress}</strong>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-[rgba(16,24,19,0.45)] px-3 py-2">
                      <span>Area</span>
                      <strong>{hasValidEnteredArea ? `${areaSummary.feddanLabel} (${areaSummary.areaLabel})` : 'Not entered'}</strong>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {step === 4 ? (
              <section className="crop-recommendations" aria-labelledby="crop-recommendations-title">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-[rgba(243,240,230,0.6)]">Step 4 · Optional</p>
                  <h3 id="crop-recommendations-title">Crop suggestions for your farm</h3>
                  <p>
                    Suggestions are informational only. No crop is selected, accepted, or planted when you enter the simulation.
                  </p>
                </div>
                {recommendationResult.status === 'placeholder' ? (
                  <div className="crop-recommendations-empty" role="status">
                    <strong>Recommendations are a placeholder</strong>
                    <span>{recommendationResult.message}</span>
                  </div>
                ) : (
                  <div className="crop-recommendation-list">
                    {recommendationResult.recommendations.map((recommendation) => (
                      <article key={recommendation.cropId}>
                        <strong>{recommendation.cropName}</strong>
                        <p>{recommendation.explanation}</p>
                      </article>
                    ))}
                  </div>
                )}
                <div className="crop-recommendation-farm-summary">
                  <strong>{worldName || 'My Virtual Farm'}</strong>
                  <span>{selectedLocation.formattedAddress} · {formatAreaDisplay(areaSquareMeters).areaLabel}</span>
                  <span>
                    {landUseRegions.filter((region) => region.kind === 'plot').length} manually defined plots
                    {' · '}
                    {landUseRegions.filter((region) => region.kind === 'excluded').length} excluded areas
                    {' · '}
                    {landUseRegions.filter((region) => region.kind === 'irrigation').length} irrigation lines
                  </span>
                </div>
              </section>
            ) : null}

            {error ? <div className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div> : null}

            <div className="mt-6 flex flex-wrap justify-between gap-3">
              <button type="button" className="secondary-button" onClick={() => navigate('/dashboard')}>
                Back to Dashboard
              </button>
              {step > 1 ? (
                <button type="button" className="secondary-button" onClick={() => handleStepChange(Math.max(1, step - 1))}>
                  Previous
                </button>
              ) : null}
              <button type="button" className="primary-button" onClick={nextStep}>
                {step === 3 ? 'Review Crop Suggestions' : step === 4 ? 'Enter Empty Simulation' : 'Next'}
              </button>
            </div>
          </div>

          <aside className="space-y-5">
            <div className="glass-card rounded-[28px] p-5">
              <p className="text-xs uppercase tracking-[0.24em] text-[rgba(243,240,230,0.6)]">Summary</p>
              <h4 className="mt-3 text-2xl font-semibold text-beige">{worldName || 'My Virtual Farm'}</h4>
              <div className="mt-5 space-y-3 text-sm">
                <div className="flex items-center justify-between rounded-xl bg-[rgba(16,24,19,0.55)] px-3 py-2">
                  <span>Location</span>
                  <strong>{formatLocationLabel(selectedLocation)}</strong>
                </div>
                <div className="flex items-center justify-between rounded-xl bg-[rgba(16,24,19,0.55)] px-3 py-2">
                  <span>Area</span>
                  <strong>{hasValidEnteredArea ? areaSummary.areaLabel : 'Pending'}</strong>
                </div>
                <div className="flex items-center justify-between rounded-xl bg-[rgba(16,24,19,0.55)] px-3 py-2">
                  <span>Boundary</span>
                  <strong>{boundary.length} vertices</strong>
                </div>
              </div>
            </div>

            <div className="glass-card rounded-[28px] p-5">
              <p className="text-xs uppercase tracking-[0.24em] text-[rgba(243,240,230,0.6)]">Validation</p>
              <div className="mt-4 space-y-3 text-sm text-[rgba(243,240,230,0.8)]">
                <div className="flex items-center justify-between rounded-xl bg-[rgba(16,24,19,0.55)] px-3 py-2">
                  <span>Valid vertices</span>
                  <strong className={boundary.length >= 3 ? 'text-greenLight' : 'text-red-200'}>{boundary.length}/3+</strong>
                </div>
                <div className="flex items-center justify-between rounded-xl bg-[rgba(16,24,19,0.55)] px-3 py-2">
                  <span>Area status</span>
                  <strong className={boundaryValidation.valid && hasValidEnteredArea ? 'text-greenLight' : 'text-red-200'}>
                    {boundaryValidation.valid && hasValidEnteredArea ? 'Ready' : 'Waiting'}
                  </strong>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

function WorldScene({
  world,
  resetVersion,
  satelliteProvider,
  processedImageryUrl,
  onProcessedImageryStateChange,
  onImageryStateChange,
  showSatelliteImage,
  showTerrain,
  showCropPrototype,
  showPlots,
  showInfrastructure,
}: {
  world: World;
  resetVersion: number;
  satelliteProvider: SatelliteProvider;
  processedImageryUrl: string | null;
  onProcessedImageryStateChange: (message: string) => void;
  onImageryStateChange: (state: ImageryState) => void;
  showSatelliteImage: boolean;
  showTerrain: boolean;
  showCropPrototype: boolean;
  showPlots: boolean;
  showInfrastructure: boolean;
}) {
  const coordinates = world.boundary.coordinates;
  const sceneSize = getFarmSceneSize(coordinates);
  const cameraDistance = sceneSize;
  const fogNear = sceneSize * 3;
  const fogFar = sceneSize * 8;
  const initialCameraDistance = cameraDistance * Math.hypot(0.65, 0.85, 0.65);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const [zoomLevel, setZoomLevel] = useState(0);
  const handleCameraChange = useCallback(() => {
    const distance = controlsRef.current?.getDistance();
    if (!distance) return;
    const nextZoomLevel = Math.max(0, Math.floor(Math.log2(initialCameraDistance / distance)));
    setZoomLevel((currentZoomLevel) => currentZoomLevel === nextZoomLevel ? currentZoomLevel : nextZoomLevel);
  }, [initialCameraDistance]);
  useEffect(() => {
    setZoomLevel(0);
  }, [resetVersion, world.id]);

  return (
    <Canvas
      key={resetVersion}
      camera={{
        position: [cameraDistance * 0.65, cameraDistance * 0.85, cameraDistance * 0.65],
        fov: 42,
        near: 0.1,
        far: cameraDistance * 10,
      }}
    >
      <color attach="background" args={['#0d1712']} />
      <fog attach="fog" args={['#0d1712', fogNear, fogFar]} />
      <ambientLight intensity={0.7} color="#f3e9d5" />
      <hemisphereLight args={['#dff7ff', '#192d23', 1.08]} />
      <directionalLight
        castShadow
        intensity={1.8}
        position={[sceneSize * 1.1, sceneSize * 2.2, sceneSize * 0.8]}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-sceneSize}
        shadow-camera-right={sceneSize}
        shadow-camera-top={sceneSize}
        shadow-camera-bottom={-sceneSize}
      />
      <FarmDigitalTwin
        coordinates={coordinates}
        mapType={world.mapType ?? 'satellite'}
        satelliteProvider={satelliteProvider}
        zoomLevel={zoomLevel}
        landUseRegions={world.landUseRegions ?? []}
        processedImagery={world.processedImagery && processedImageryUrl
          ? { url: processedImageryUrl, bounds: world.processedImagery.bounds }
          : undefined}
        onProcessedImageryStateChange={onProcessedImageryStateChange}
        mapTilerApiKey={mapTilerApiKey}
        mapboxAccessToken={mapboxAccessToken}
        onImageryStateChange={onImageryStateChange}
        showSatelliteImage={showSatelliteImage}
        showTerrain={showTerrain}
        showCropPrototype={showCropPrototype}
        showPlots={showPlots}
        showInfrastructure={showInfrastructure}
      />

      <OrbitControls
        ref={controlsRef}
        onChange={handleCameraChange}
        enablePan
        enableRotate
        enableZoom
        enableDamping
        dampingFactor={0.08}
        minPolarAngle={0.04}
        maxPolarAngle={1.48}
        minDistance={Math.max(2, sceneSize * 0.08)}
        maxDistance={sceneSize * 4}
        target={[0, 0, 0]}
      />
    </Canvas>
  );
}

function WorldPage() {
  const { worldId } = useParams();
  const navigate = useNavigate();
  const simulationRef = useRef<HTMLDivElement | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const [satelliteProvider, setSatelliteProvider] = useState<SatelliteProvider>(() => {
    try {
      return sessionStorage.getItem(IMAGERY_PROVIDER_SESSION_KEY) === 'mapbox' ? 'mapbox' : 'maptiler';
    } catch {
      return 'maptiler';
    }
  });
  const [world, setWorld] = useState<World | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [processedImageryUrl, setProcessedImageryUrl] = useState<string | null>(null);
  const [processedImageryState, setProcessedImageryState] = useState('');
  const [imageryState, setImageryState] = useState<ImageryState>({
    status: 'off',
    provider: null,
    zoom: null,
    maxZoom: null,
    message: 'Loading the selected farm imagery.',
  });
  const [showSatelliteImage, setShowSatelliteImage] = useState(true);
  const [showPlots, setShowPlots] = useState(true);
  const [showInfrastructure, setShowInfrastructure] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [scenarioName, setScenarioName] = useState('');
  const [scenarioPlotId, setScenarioPlotId] = useState('');
  const [scenarioCrop, setScenarioCrop] = useState<ScenarioCrop>('wheat');
  const [scenarioPlantingDate, setScenarioPlantingDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [scenarioSoilDescription, setScenarioSoilDescription] = useState('');
  const [scenarioIrrigationVolume, setScenarioIrrigationVolume] = useState('');
  const [scenarioEtc, setScenarioEtc] = useState('');
  const [scenarioEffectiveRainfall, setScenarioEffectiveRainfall] = useState('');
  const [scenarioEfficiency, setScenarioEfficiency] = useState('');
  const [scenarioInputSource, setScenarioInputSource] = useState('');
  const [scenarioError, setScenarioError] = useState('');
  const [comparisonIds, setComparisonIds] = useState<string[]>([]);
  const handleImageryStateChange = useCallback((state: ImageryState) => {
    setImageryState(state);
  }, []);
  const handleProcessedImageryStateChange = useCallback((message: string) => {
    setProcessedImageryState(message);
  }, []);
  const handleSatelliteProviderChange = (provider: SatelliteProvider) => {
    setSatelliteProvider(provider);
    try {
      sessionStorage.setItem(IMAGERY_PROVIDER_SESSION_KEY, provider);
    } catch {
      // The provider still changes for this view if session storage is unavailable.
    }
  };
  const handleToggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await simulationRef.current?.requestFullscreen();
      }
      setFullscreenError('');
    } catch (error) {
      setFullscreenError(error instanceof Error ? error.message : 'Fullscreen mode is unavailable in this browser.');
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === simulationRef.current);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    const currentUser = getCurrentUser();
    const found = worldId && currentUser
      ? getWorldsForUser(currentUser.id).find((entry) => entry.id === worldId) ?? null
      : null;
    setWorld(found);
    setIsLoading(false);
  }, [worldId]);

  useEffect(() => {
    if (!world?.processedImagery) {
      setProcessedImageryUrl(null);
      setProcessedImageryState('');
      return;
    }

    let active = true;
    let objectUrl: string | null = null;
    void loadProcessedImagery(world.id)
      .then((blob) => {
        if (!active) return;
        if (!blob) {
          setProcessedImageryState('Processed image file is missing from this browser. Original satellite imagery remains visible.');
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setProcessedImageryUrl(objectUrl);
      })
      .catch((loadError: unknown) => {
        if (active) setProcessedImageryState(loadError instanceof Error ? loadError.message : 'Processed image could not be loaded.');
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setProcessedImageryUrl(null);
    };
  }, [world?.id, world?.processedImagery]);

  if (isLoading) return null;

  if (!world) {
    return <Navigate to="/dashboard" replace />;
  }

  const { areaLabel, feddanLabel } = formatAreaDisplay(world.areaSquareMeters);
  const plots = (world.landUseRegions ?? []).filter((region) => region.kind === 'plot');
  const irrigationLines = (world.landUseRegions ?? []).filter((region) => region.kind === 'irrigation');
  const excludedAreas = (world.landUseRegions ?? []).filter((region) => region.kind === 'excluded');
  const scenarios = world.scenarios ?? [];
  const selectedScenarioPlot = plots.find((plot) => plot.id === scenarioPlotId) ?? plots[0];
  const selectedScenarioPlotArea = selectedScenarioPlot ? getLandArea(selectedScenarioPlot.coordinates) : 0;
  const parseOptionalNumber = (value: string): number | null => value.trim() === '' ? null : Number(value);
  const draftScenario: FarmScenario | null = selectedScenarioPlot ? {
    id: 'draft',
    name: scenarioName || 'Draft scenario',
    plotId: selectedScenarioPlot.id,
    plotName: selectedScenarioPlot.name,
    plotAreaSquareMeters: selectedScenarioPlotArea,
    crop: scenarioCrop,
    plantingDate: scenarioPlantingDate,
    soilDescription: scenarioSoilDescription,
    plannedIrrigationVolumeM3: parseOptionalNumber(scenarioIrrigationVolume),
    seasonalEtcMm: parseOptionalNumber(scenarioEtc),
    effectiveRainfallMm: parseOptionalNumber(scenarioEffectiveRainfall),
    applicationEfficiencyPercent: parseOptionalNumber(scenarioEfficiency),
    inputSource: scenarioInputSource,
    createdAt: '',
  } : null;
  const draftWaterBalance = draftScenario ? calculateWaterBalance(draftScenario) : null;
  const comparisonScenarios = comparisonIds
    .map((id) => scenarios.find((scenario) => scenario.id === id))
    .filter((scenario): scenario is FarmScenario => Boolean(scenario));

  const handleSaveScenario = () => {
    if (!selectedScenarioPlot || selectedScenarioPlotArea <= 0) {
      setScenarioError('Select a mapped agricultural plot with a valid measured area first.');
      return;
    }
    if (!scenarioName.trim()) {
      setScenarioError('Enter a name for this scenario.');
      return;
    }
    if (!scenarioPlantingDate || Number.isNaN(Date.parse(scenarioPlantingDate))) {
      setScenarioError('Choose a valid planting date.');
      return;
    }

    const values = [
      ['Planned irrigation volume', scenarioIrrigationVolume],
      ['Seasonal ETc', scenarioEtc],
      ['Effective rainfall', scenarioEffectiveRainfall],
      ['Application efficiency', scenarioEfficiency],
    ] as const;
    const parsedValues = values.map(([label, value]) => ({
      label,
      raw: value,
      value: parseOptionalNumber(value),
    }));
    const invalidValue = parsedValues.find(({ raw, value }) => (
      raw.trim() !== '' && (value === null || !Number.isFinite(value) || value < 0)
    ));
    if (invalidValue) {
      setScenarioError(`${invalidValue.label} must be a non-negative number.`);
      return;
    }
    const efficiency = parseOptionalNumber(scenarioEfficiency);
    if (efficiency !== null && (efficiency <= 0 || efficiency > 100)) {
      setScenarioError('Application efficiency must be greater than 0 and no more than 100 percent.');
      return;
    }
    if ((scenarioEtc.trim() || scenarioEffectiveRainfall.trim() || scenarioEfficiency.trim())
      && !scenarioInputSource.trim()) {
      setScenarioError('Add the source for ETc, rainfall, and efficiency values before saving.');
      return;
    }

    const scenario: FarmScenario = {
      id: crypto.randomUUID(),
      name: scenarioName.trim(),
      plotId: selectedScenarioPlot.id,
      plotName: selectedScenarioPlot.name,
      plotAreaSquareMeters: selectedScenarioPlotArea,
      crop: scenarioCrop,
      plantingDate: scenarioPlantingDate,
      soilDescription: scenarioSoilDescription.trim(),
      plannedIrrigationVolumeM3: parseOptionalNumber(scenarioIrrigationVolume),
      seasonalEtcMm: parseOptionalNumber(scenarioEtc),
      effectiveRainfallMm: parseOptionalNumber(scenarioEffectiveRainfall),
      applicationEfficiencyPercent: efficiency,
      inputSource: scenarioInputSource.trim(),
      createdAt: new Date().toISOString(),
    };
    const updatedWorld = { ...world, scenarios: [...scenarios, scenario] };
    upsertWorld(updatedWorld);
    setWorld(updatedWorld);
    setComparisonIds((current) => [...current.filter((id) => id !== scenarios.at(-1)?.id), scenario.id].slice(-2));
    setScenarioName('');
    setScenarioError('');
  };

  const handleDeleteScenario = (scenarioId: string) => {
    const updatedWorld = { ...world, scenarios: scenarios.filter((scenario) => scenario.id !== scenarioId) };
    upsertWorld(updatedWorld);
    setWorld(updatedWorld);
    setComparisonIds((current) => current.filter((id) => id !== scenarioId));
  };

  const handleToggleComparison = (scenarioId: string) => {
    setComparisonIds((current) => current.includes(scenarioId)
      ? current.filter((id) => id !== scenarioId)
      : current.length < 2 ? [...current, scenarioId] : [current[1], scenarioId]);
  };

  return (
    <div ref={simulationRef} className="app-shell scenario-page" dir="rtl">
      <header className="scenario-header">
        <div className="scenario-brand">
          <Logo />
          <div><strong>مختبر المزرعة الافتراضية</strong><span>AGRI–OR–DIE · تخطيط السيناريوهات</span></div>
        </div>
        <div className="scenario-farm-heading">
          <span className="scenario-live-indicator" />
          <div><strong>{world.name}</strong><span><MapPin size={13} />{formatLocationLabel(world.location)}</span></div>
        </div>
        <div className="scenario-header-actions">
          <label className="scenario-provider">
            <span>مصدر الصورة</span>
            <select
              aria-label="Satellite imagery provider"
              value={satelliteProvider}
              onChange={(event) => handleSatelliteProviderChange(event.target.value === 'mapbox' ? 'mapbox' : 'maptiler')}
            >
              <option value="maptiler">MapTiler</option>
              <option value="mapbox">Mapbox</option>
            </select>
          </label>
          <button type="button" className="scenario-icon-button" aria-label="Toggle fullscreen" title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => void handleToggleFullscreen()}>
            {isFullscreen ? <Minimize2 size={17} /> : <Expand size={17} />}
          </button>
          <button type="button" className="scenario-icon-button" aria-label="Reset camera" title="Reset camera" onClick={() => setResetVersion((value) => value + 1)}>
            <RotateCcw size={17} />
          </button>
          <button type="button" className="scenario-header-button" onClick={() => navigate(`/create-world?edit=${encodeURIComponent(world.id)}`)}>
            <PencilLine size={15} /><span>تحرير بيانات الأرض</span>
          </button>
          <button type="button" className="scenario-header-button secondary" onClick={() => navigate('/dashboard')}>
            <ArrowLeft size={16} /><span>لوحة المزارع</span>
          </button>
        </div>
      </header>

      <main className="scenario-main">
        <section className="scenario-intro">
          <div>
            <span className="scenario-kicker"><FlaskConical size={15} /> توأم رقمي · تجربة قبل التنفيذ</span>
            <h1>جرّب قرارك على أرضك، قبل ما تطبّقه</h1>
            <p>اربط الخريطة ببيانات المزرعة، سجّل افتراضاتك، وقارن خطط الري. الحسابات لا تظهر إلا عند اكتمال المدخلات الموثقة.</p>
          </div>
          <div className="scenario-intro-meta">
            <span><Ruler size={15} />{feddanLabel} · {areaLabel}</span>
            <span><LayoutGrid size={15} />{plots.length} قطعة معرفة</span>
          </div>
        </section>

        <div className="scenario-grid">
          <section className="scenario-card scenario-map-card" aria-labelledby="farm-map-title">
            <div className="scenario-card-heading">
              <div><span className="scenario-step">01</span><div><h2 id="farm-map-title">الأرض الفعلية</h2><p>صورة القمر الصناعي وحدود المزرعة المحفوظة</p></div></div>
              <div className="scenario-map-toggles">
                <button type="button" aria-pressed={showSatelliteImage} className={showSatelliteImage ? 'selected' : ''} onClick={() => setShowSatelliteImage((value) => !value)}>الصورة</button>
                <button type="button" aria-pressed={showPlots} className={showPlots ? 'selected' : ''} onClick={() => setShowPlots((value) => !value)}>القطع</button>
                <button type="button" aria-pressed={showInfrastructure} className={showInfrastructure ? 'selected' : ''} onClick={() => setShowInfrastructure((value) => !value)}>المرافق</button>
              </div>
            </div>
            <div className="scenario-map-window">
              <WorldScene
                world={world}
                resetVersion={resetVersion}
                satelliteProvider={satelliteProvider}
                processedImageryUrl={processedImageryUrl}
                onProcessedImageryStateChange={handleProcessedImageryStateChange}
                onImageryStateChange={handleImageryStateChange}
                showSatelliteImage={showSatelliteImage}
                showTerrain={false}
                showCropPrototype={false}
                showPlots={showPlots}
                showInfrastructure={showInfrastructure}
              />
              <div className={`scenario-imagery-state ${imageryState.status}`} role="status" aria-live="polite">
                {imageryState.status === 'loading' ? <span className="digital-twin-spinner" aria-hidden="true" /> : null}
                <span>{imageryState.status === 'ready'
                  ? `الصورة محمّلة · مستوى البلاطات z${imageryState.zoom}`
                  : imageryState.status === 'error'
                    ? 'تعذّر تحميل صورة القمر الصناعي'
                    : imageryState.status === 'off' ? 'صورة القمر الصناعي متوقفة' : 'جارٍ تحميل صورة الأرض'}</span>
              </div>
            </div>
            <p className="scenario-imagery-message">{imageryState.message}</p>
            {processedImageryState ? <p className="scenario-imagery-message">{processedImageryState}</p> : null}
            <div className="scenario-map-facts">
              <span><MapPin size={14} />{world.location.latitude.toFixed(5)}, {world.location.longitude.toFixed(5)}</span>
              <span><LayoutGrid size={14} />{plots.length} قطع زراعية مرسومة</span>
              <span><Droplets size={14} />{irrigationLines.length} خطوط ري مسجلة</span>
              <span><RouteIcon size={14} />{excludedAreas.length} مناطق مستبعدة</span>
            </div>
            <p className="scenario-attribution">
              © <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noreferrer">MapTiler</a>
              {' · '}<a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noreferrer">Mapbox</a>
              {' · '}<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
            </p>
          </section>

          <section className="scenario-card scenario-builder" aria-labelledby="scenario-builder-title">
            <div className="scenario-card-heading">
              <div><span className="scenario-step">02</span><div><h2 id="scenario-builder-title">جهّز سيناريو زراعي</h2><p>مدخلاتك محفوظة لكل تجربة، من غير زراعة افتراضية</p></div></div>
              <span className="scenario-data-badge"><Database size={14} /> مدخلات يدوية</span>
            </div>

            {plots.length === 0 ? (
              <div className="scenario-empty-plots">
                <CircleAlert size={20} />
                <strong>لا توجد قطعة زراعية معرفة بعد</strong>
                <p>ارسم واحفظ حدود قطعة من «تحرير بيانات الأرض» قبل إنشاء سيناريو؛ لن نعتبر المزرعة كلها مساحة قابلة للزراعة تلقائيًا.</p>
                <button type="button" onClick={() => navigate(`/create-world?edit=${encodeURIComponent(world.id)}`)}>إضافة القطع الزراعية</button>
              </div>
            ) : (
              <form className="scenario-form" onSubmit={(event) => { event.preventDefault(); handleSaveScenario(); }}>
                <label className="scenario-field">
                  <span>اسم التجربة</span>
                  <input value={scenarioName} onChange={(event) => setScenarioName(event.target.value)} placeholder="مثال: ري أقل في الموسم القادم" required />
                </label>
                <div className="scenario-field-row">
                  <label className="scenario-field">
                    <span>القطعة الزراعية</span>
                    <select value={selectedScenarioPlot?.id ?? ''} onChange={(event) => setScenarioPlotId(event.target.value)}>
                      {plots.map((plot) => <option key={plot.id} value={plot.id}>{plot.name} · {formatNumber(Math.round(getLandArea(plot.coordinates)))} م²</option>)}
                    </select>
                  </label>
                  <label className="scenario-field">
                    <span>المحصول المخطط</span>
                    <select value={scenarioCrop} onChange={(event) => setScenarioCrop(event.target.value as ScenarioCrop)}>
                      <option value="wheat">قمح</option>
                      <option value="corn">ذرة</option>
                      <option value="rice">أرز</option>
                      <option value="tomato">طماطم</option>
                      <option value="potato">بطاطس</option>
                      <option value="cotton">قطن</option>
                      <option value="other">محصول آخر</option>
                    </select>
                  </label>
                </div>
                <div className="scenario-field-row">
                  <label className="scenario-field">
                    <span><CalendarDays size={14} /> موعد الزراعة</span>
                    <input type="date" value={scenarioPlantingDate} onChange={(event) => setScenarioPlantingDate(event.target.value)} required />
                  </label>
                  <label className="scenario-field">
                    <span><TestTube2 size={14} /> قوام التربة (للتسجيل فقط)</span>
                    <select value={scenarioSoilDescription} onChange={(event) => setScenarioSoilDescription(event.target.value)}>
                      <option value="">غير معروف</option>
                      <option value="sandy">رملية</option>
                      <option value="loamy">مزيجية</option>
                      <option value="clayey">طينية</option>
                      <option value="measured">موصوفة بتحليل</option>
                    </select>
                  </label>
                </div>
                <div className="scenario-divider"><span>ميزان مياه موسمي اختياري</span><i /></div>
                <p className="scenario-form-note">أدخل قيماً معروفة لديك من مصدر موثوق. هذه الحاسبة لا تستنتج المناخ أو احتياج المحصول من اسمه.</p>
                <div className="scenario-field-row">
                  <label className="scenario-field">
                    <span>ماء الري المخطط للموسم (م³)</span>
                    <input type="number" min="0" step="any" value={scenarioIrrigationVolume} onChange={(event) => setScenarioIrrigationVolume(event.target.value)} placeholder="من خطة الري" />
                  </label>
                  <label className="scenario-field">
                    <span>ETc للموسم (ملم)</span>
                    <input type="number" min="0" step="any" value={scenarioEtc} onChange={(event) => setScenarioEtc(event.target.value)} placeholder="من مصدر موثوق" />
                  </label>
                </div>
                <div className="scenario-field-row">
                  <label className="scenario-field">
                    <span>المطر الفعال (ملم)</span>
                    <input type="number" min="0" step="any" value={scenarioEffectiveRainfall} onChange={(event) => setScenarioEffectiveRainfall(event.target.value)} placeholder="من سجل محلي" />
                  </label>
                  <label className="scenario-field">
                    <span>كفاءة تطبيق الري (%)</span>
                    <input type="number" min="0.1" max="100" step="any" value={scenarioEfficiency} onChange={(event) => setScenarioEfficiency(event.target.value)} placeholder="قياس أو مرجع النظام" />
                  </label>
                </div>
                <label className="scenario-field">
                  <span>مصدر بيانات ETc / المطر / الكفاءة</span>
                  <input value={scenarioInputSource} onChange={(event) => setScenarioInputSource(event.target.value)} placeholder="مثال: تقرير إرشادي أو سجل محطة" />
                </label>

                <div className={`scenario-live-result ${draftWaterBalance ? 'available' : ''}`} aria-live="polite">
                  <div><span className="scenario-result-icon"><Droplets size={17} /></span><span><strong>{draftWaterBalance ? 'ميزان الماء المحسوب' : 'نتيجة الميزان غير متاحة بعد'}</strong><small>{draftWaterBalance ? 'حساب وحدات ومدخلات موسمية فقط؛ ليس توقعًا للمحصول.' : 'يلزم إدخال حجم الري وETc والمطر الفعال والكفاءة.'}</small></span></div>
                  {draftWaterBalance ? (
                    <dl>
                      <div><dt>الاحتياج الصافي المدخل</dt><dd>{draftWaterBalance.netIrrigationRequirementMm.toFixed(1)} ملم</dd></div>
                      <div><dt>الري الفعال المحسوب</dt><dd>{draftWaterBalance.effectiveIrrigationMm.toFixed(1)} ملم</dd></div>
                      <div><dt>العجز في المدخلات</dt><dd>{draftWaterBalance.deficitMm.toFixed(1)} ملم</dd></div>
                    </dl>
                  ) : null}
                </div>
                {scenarioError ? <p className="scenario-error" role="alert">{scenarioError}</p> : null}
                <button type="submit" className="scenario-save-button" disabled={!selectedScenarioPlot}>
                  <Plus size={17} /> حفظ السيناريو
                </button>
              </form>
            )}
          </section>
        </div>

        <section className="scenario-card scenario-saved-section" aria-labelledby="saved-scenarios-title">
          <div className="scenario-card-heading">
            <div><span className="scenario-step">03</span><div><h2 id="saved-scenarios-title">السيناريوهات المحفوظة</h2><p>قارن خططًا مختلفة على القطعة نفسها أو قطع أخرى</p></div></div>
            <span className="scenario-count">{scenarios.length} تجارب</span>
          </div>
          {scenarios.length === 0 ? (
            <div className="scenario-empty-state">
              <FlaskConical size={22} />
              <div><strong>ابدأ بتجربة أولى</strong><p>لن تُضاف محاصيل إلى الأرض؛ حفظ السيناريو يسجل خطة افتراضية للمقارنة فقط.</p></div>
            </div>
          ) : (
            <div className="scenario-saved-list">
              {scenarios.map((scenario) => {
                const balance = calculateWaterBalance(scenario);
                return (
                  <article key={scenario.id} className={comparisonIds.includes(scenario.id) ? 'scenario-saved-card comparing' : 'scenario-saved-card'}>
                    <label className="scenario-compare-check">
                      <input type="checkbox" checked={comparisonIds.includes(scenario.id)} onChange={() => handleToggleComparison(scenario.id)} aria-label={`Compare ${scenario.name}`} />
                      قارن
                    </label>
                    <div className="scenario-saved-title"><Wheat size={17} /><strong>{scenario.name}</strong></div>
                    <p>{scenario.plotName} · {scenario.crop} · {scenario.plantingDate}</p>
                    <span>{balance ? `عجز مائي مدخل: ${balance.deficitMm.toFixed(1)} ملم` : 'ميزان الماء غير مكتمل'}</span>
                    <button type="button" className="scenario-delete-button" aria-label={`Delete ${scenario.name}`} onClick={() => handleDeleteScenario(scenario.id)}><Trash2 size={15} /></button>
                  </article>
                );
              })}
            </div>
          )}
          {comparisonScenarios.length > 0 ? (
            <div className="scenario-comparison" aria-live="polite">
              <div className="scenario-comparison-heading"><h3>مقارنة مدخلات الماء</h3><span>{comparisonScenarios.length === 1 ? 'اختر سيناريوً ثانيًا لإظهار الفروق' : 'المقارنة لا تتنبأ بالغلة أو الإجهاد'}</span></div>
              <div className="scenario-comparison-grid">
                {comparisonScenarios.map((scenario) => {
                  const balance = calculateWaterBalance(scenario);
                  return (
                    <article key={scenario.id}>
                      <h4>{scenario.name}</h4>
                      <p>{scenario.plotName} · {scenario.crop}</p>
                      {balance ? (
                        <dl>
                          <div><dt>ماء الري الفعال</dt><dd>{balance.effectiveIrrigationMm.toFixed(1)} ملم</dd></div>
                          <div><dt>الاحتياج الصافي المدخل</dt><dd>{balance.netIrrigationRequirementMm.toFixed(1)} ملم</dd></div>
                          <div><dt>العجز الحسابي</dt><dd>{balance.deficitMm.toFixed(1)} ملم</dd></div>
                          <div><dt>حجم الري الإجمالي اللازم حسابيًا</dt><dd>{balance.requiredGrossIrrigationVolumeM3.toFixed(1)} م³</dd></div>
                        </dl>
                      ) : <p className="scenario-missing-inputs">لا توجد مدخلات موثقة كافية لحساب ميزان الماء.</p>}
                      {scenario.inputSource ? <small>المصدر المسجل: {scenario.inputSource}</small> : null}
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}
        </section>

        <aside className="scenario-science-note">
          <span><CircleAlert size={18} /></span>
          <div><strong>حدود علمية واضحة</strong><p>النسخة الحالية تحفظ سيناريوهات افتراضية وتحسب ميزانًا مائيًا موسميًا مبسطًا من القيم التي تدخلها فقط. لا يوجد اتصال ببيانات طقس أو تربة، ولا تنبؤ بالإنتاج أو الإجهاد الحراري أو التوصية الزراعية. نتائج الماء لا تشمل تخزين التربة أو الجريان أو تغير الاحتياج اليومي.</p></div>
          <CheckCircle2 size={17} className="scenario-note-check" />
        </aside>
        {fullscreenError ? <p className="scenario-error" role="alert">{fullscreenError}</p> : null}
      </main>
    </div>
  );
}

function App() {
  const currentUser = getCurrentUser();

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={<Navigate to="/dashboard" replace />} />
      <Route path="/register" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<DashboardPage currentUser={currentUser} />} />
      <Route path="/create-world" element={<CreateWorldPage currentUser={currentUser} />} />
      <Route path="/world/:worldId" element={<WorldPage />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function RootApp() {
  return <App />;
}
