import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CircleMarker, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, ZoomControl, useMap, useMapEvents } from 'react-leaflet';
import type { LeafletMouseEvent } from 'leaflet';
import { ChevronDown, MapPin, Maximize, Search } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LandUseRegion } from './landUse';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface FarmLocation extends GeoPoint {
  formattedAddress: string;
}

export interface FarmBoundary {
  coordinates: GeoPoint[];
  areaSquareMeters: number;
  areaFeddans: number;
}

export type MapViewType = 'satellite' | 'hybrid' | 'roadmap';
export type MapTool = 'location' | 'idle' | 'drawing' | 'editing';

export interface LandUseDigitizer {
  mode: 'idle' | 'drawing' | 'editing';
  coordinates: GeoPoint[];
  kind: 'plot' | 'excluded' | 'irrigation';
  onChange: (coordinates: GeoPoint[]) => void;
}

interface SearchSuggestion {
  id: string;
  label: string;
  point: GeoPoint;
}

interface PhotonFeature {
  geometry?: { coordinates?: number[] };
  properties?: {
    name?: string;
    street?: string;
    city?: string;
    locality?: string;
    state?: string;
    country?: string;
  };
}

interface PhotonResponse {
  features?: PhotonFeature[];
}

interface FarmMapProps {
  location: FarmLocation;
  boundary: GeoPoint[];
  mapType: MapViewType;
  tool: MapTool;
  selectedVertex: number | null;
  onLocationChange: (location: FarmLocation) => void;
  onBoundaryChange: (coordinates: GeoPoint[]) => void;
  onMapTypeChange: (mapType: MapViewType) => void;
  onToolChange: (tool: MapTool) => void;
  onSelectedVertexChange: (index: number | null) => void;
  landUseRegions?: LandUseRegion[];
  digitizer?: LandUseDigitizer;
}

const EGYPT_CENTER: [number, number] = [26.8206, 30.8025];
const mapTilerApiKey = import.meta.env.VITE_MAPTILER_API_KEY?.trim() ?? '';
const hasMapTilerKey = Boolean(mapTilerApiKey && !/^(your|replace|change|insert|<)/i.test(mapTilerApiKey));

const pointToLatLng = (point: GeoPoint): [number, number] => [point.latitude, point.longitude];
const toGeoPoint = (latitude: number, longitude: number): GeoPoint => ({ latitude, longitude });

const locationIcon = L.divIcon({
  className: 'farm-map-leaflet-location-wrap',
  html: '<span class="farm-map-leaflet-location"></span>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

const vertexIcon = (selected: boolean) => L.divIcon({
  className: 'farm-map-leaflet-vertex-wrap',
  html: `<span class="farm-map-leaflet-vertex ${selected ? 'selected' : ''}"></span>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const MAPTILER_ATTRIBUTION = '&copy; <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noreferrer">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>';

const pointFromFeature = (feature: PhotonFeature): SearchSuggestion | null => {
  const coordinates = feature.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [longitude, latitude] = coordinates;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const properties = feature.properties ?? {};
  const label = [
    properties.name,
    properties.street,
    properties.city ?? properties.locality,
    properties.state,
    properties.country,
  ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(', ');

  return {
    id: `${longitude},${latitude}`,
    label: label || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
    point: toGeoPoint(latitude, longitude),
  };
};

function MapSearch({
  location,
  onChoose,
}: {
  location: FarmLocation;
  onChoose: (suggestion: SearchSuggestion) => void;
}) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [open, setOpen] = useState(false);
  const requestId = useRef(0);
  const skipQuery = useRef<string | null>(null);

  useEffect(() => {
    if (skipQuery.current === query) {
      skipQuery.current = null;
      return;
    }

    const text = query.trim();
    if (text.length < 3) {
      setSuggestions([]);
      setSearchError('');
      setIsSearching(false);
      return;
    }

    const request = ++requestId.current;
    const controller = new AbortController();
    setIsSearching(true);
    setSearchError('');
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: text.replace(/(?:,\s*|\s+)egypt\s*$/i, '').trim(),
          lat: String(location.latitude),
          lon: String(location.longitude),
          limit: '6',
        });
        const response = await fetch(`https://photon.komoot.io/api/?${params.toString()}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Place search is temporarily unavailable.');
        const data = await response.json() as PhotonResponse;
        const results = (data.features ?? [])
          .map(pointFromFeature)
          .filter((suggestion): suggestion is SearchSuggestion => suggestion !== null);
        if (request === requestId.current) {
          setSuggestions(results);
          setOpen(true);
        }
      } catch (error) {
        if (request === requestId.current && !(error instanceof DOMException && error.name === 'AbortError')) {
          setSuggestions([]);
          setSearchError('Could not search places right now. You can still select a point directly on the map.');
        }
      } finally {
        if (request === requestId.current) setIsSearching(false);
      }
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [location.latitude, location.longitude, query]);

  const selectSuggestion = (suggestion: SearchSuggestion) => {
    onChoose(suggestion);
    skipQuery.current = suggestion.label;
    setQuery(suggestion.label);
    setSuggestions([]);
    setOpen(false);
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (suggestions[0]) selectSuggestion(suggestions[0]);
  };

  return (
    <div className="farm-map-search-wrap">
      <form className="farm-map-search" onSubmit={submitSearch}>
        <Search size={17} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
          placeholder="Search cities, villages, addresses..."
          aria-label="Search a farm location"
          autoComplete="off"
        />
        {isSearching ? <span className="farm-map-search-status">Searching</span> : null}
        <button type="submit" className="map-search-submit" aria-label="Search locations"><ChevronDown size={16} /></button>
      </form>
      {open && suggestions.length > 0 ? (
        <div className="farm-map-suggestions" role="listbox">
          {suggestions.map((suggestion) => (
            <button type="button" key={suggestion.id} role="option" onClick={() => selectSuggestion(suggestion)}>
              <MapPin size={15} /><span>{suggestion.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {searchError ? <p className="farm-map-inline-error">{searchError}</p> : null}
    </div>
  );
}

function MapTypeSelector({
  activeMapType,
  onMapTypeChange,
  satelliteAvailable,
}: {
  activeMapType: MapViewType;
  onMapTypeChange: (mapType: MapViewType) => void;
  satelliteAvailable: boolean;
}) {
  return (
    <div className="farm-map-type-control" role="group" aria-label="Map type">
      {([
        ['satellite', 'Satellite'],
        ['hybrid', 'Hybrid'],
        ['roadmap', 'OpenStreetMap'],
      ] as const).map(([type, label]) => (
        <button
          key={type}
          type="button"
          className={activeMapType === type ? 'active' : ''}
          aria-pressed={activeMapType === type}
          disabled={type !== 'roadmap' && !satelliteAvailable}
          title={type !== 'roadmap' && !satelliteAvailable
            ? 'Add a MapTiler API key to enable satellite imagery'
            : `Show ${label.toLowerCase()} map`}
          onClick={() => onMapTypeChange(type)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function MapEvents({
  location,
  boundary,
  tool,
  digitizer,
  onLocationChange,
  onBoundaryChange,
  onSelectedVertexChange,
}: Pick<FarmMapProps, 'location' | 'boundary' | 'tool' | 'digitizer' | 'onLocationChange' | 'onBoundaryChange' | 'onSelectedVertexChange'>) {
  const map = useMap();
  const lastLocation = useRef(location);
  const fittedSavedBoundary = useRef(false);

  useEffect(() => {
    const locationChanged = lastLocation.current.latitude !== location.latitude
      || lastLocation.current.longitude !== location.longitude;
    lastLocation.current = location;
    if (locationChanged) map.setView(pointToLatLng(location), Math.max(map.getZoom(), 13));
  }, [location, map]);

  useEffect(() => {
    if (tool !== 'idle' || boundary.length < 3 || fittedSavedBoundary.current) return;
    const bounds = L.latLngBounds(boundary.map(pointToLatLng));
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [24, 24] });
      fittedSavedBoundary.current = true;
    }
  }, [boundary, map, tool]);

  const latest = useRef({ location, boundary, tool, digitizer, onLocationChange, onBoundaryChange, onSelectedVertexChange });
  latest.current = { location, boundary, tool, digitizer, onLocationChange, onBoundaryChange, onSelectedVertexChange };

  useMapEvents({
    click(event) {
      const current = latest.current;
      const point = toGeoPoint(event.latlng.lat, event.latlng.lng);
      if (current.digitizer?.mode === 'drawing') {
        current.digitizer.onChange([...current.digitizer.coordinates, point]);
      } else if (current.digitizer?.mode === 'editing') {
        current.digitizer.onChange([...current.digitizer.coordinates, point]);
      } else if (current.tool === 'location') {
        current.onLocationChange({ ...point, formattedAddress: 'Selected map location' });
      } else if (current.tool === 'drawing' || current.tool === 'editing') {
        current.onBoundaryChange([...current.boundary, point]);
        if (current.tool === 'editing') current.onSelectedVertexChange(current.boundary.length);
      }
    },
  });

  useEffect(() => {
    const container = map.getContainer();
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [map]);

  return null;
}

function LandUseLayer({
  regions,
  digitizer,
}: {
  regions: LandUseRegion[];
  digitizer?: LandUseDigitizer;
}) {
  const activeColors = digitizer?.kind === 'excluded'
    ? { color: '#cf543f', fillColor: '#f07354' }
    : digitizer?.kind === 'irrigation'
      ? { color: '#53d5ff', fillColor: '#54c4ff' }
      : { color: '#197b46', fillColor: '#67cf82' };

  return (
    <>
      {regions.map((region) => region.kind === 'irrigation' ? (
        <Polyline
          key={region.id}
          positions={region.coordinates.map(pointToLatLng)}
          pathOptions={{
            color: '#53d5ff',
            weight: 5,
            opacity: 0.95,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        >
          <Tooltip sticky>Irrigation network — {region.name}</Tooltip>
        </Polyline>
      ) : (
        <Polygon
          key={region.id}
          positions={region.coordinates.map(pointToLatLng)}
          pathOptions={{
            interactive: false,
            color: region.kind === 'excluded' ? '#d94f3d' : '#1c8b50',
            weight: 3,
            fillColor: region.kind === 'excluded' ? '#e7654e' : '#79d78c',
            fillOpacity: 0.26,
          }}
        >
          <Tooltip sticky>{region.kind === 'excluded' ? `Excluded: ${region.excludedType ?? 'area'}` : 'Verified planting plot'} — {region.name}</Tooltip>
        </Polygon>
      ))}
      {digitizer && digitizer.coordinates.length >= 2 ? (
        digitizer.kind === 'irrigation' ? (
          <Polyline
            positions={digitizer.coordinates.map(pointToLatLng)}
            pathOptions={{ ...activeColors, interactive: false, weight: 5, opacity: 0.9, dashArray: digitizer.mode === 'drawing' ? '8 8' : undefined }}
          />
        ) : (
          <Polygon
            positions={digitizer.coordinates.map(pointToLatLng)}
            pathOptions={{ ...activeColors, interactive: false, weight: 3, fillOpacity: 0.22, dashArray: digitizer.mode === 'drawing' ? '6 6' : undefined }}
          />
        )
      ) : null}
      {digitizer?.coordinates.map((point, index) => (
        <Marker
          key={`land-use-${index}-${point.latitude}-${point.longitude}`}
          position={pointToLatLng(point)}
          icon={vertexIcon(false)}
          draggable={digitizer.mode === 'editing'}
          eventHandlers={{
            contextmenu(event) {
              L.DomEvent.stopPropagation(event.originalEvent);
              digitizer.onChange(digitizer.coordinates.filter((_, vertexIndex) => vertexIndex !== index));
            },
            dragend(event) {
              const { lat, lng } = event.target.getLatLng();
              digitizer.onChange(digitizer.coordinates.map((current, vertexIndex) => vertexIndex === index
                ? toGeoPoint(lat, lng)
                : current));
            },
          }}
        />
      )) ?? null}
      {digitizer?.mode === 'editing' && digitizer.coordinates.length >= 3
        ? digitizer.coordinates.map((point, index) => {
          const nextPoint = digitizer.coordinates[(index + 1) % digitizer.coordinates.length];
          return (
            <CircleMarker
              key={`land-use-insert-${index}`}
              center={[(point.latitude + nextPoint.latitude) / 2, (point.longitude + nextPoint.longitude) / 2]}
              radius={6}
              pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#f0be4c', fillOpacity: 1, bubblingMouseEvents: false }}
              eventHandlers={{
                click(event) {
                  L.DomEvent.stopPropagation(event.originalEvent);
                  const nextCoordinates = [...digitizer.coordinates];
                  nextCoordinates.splice(index + 1, 0, toGeoPoint(event.latlng.lat, event.latlng.lng));
                  digitizer.onChange(nextCoordinates);
                },
              }}
            />
          );
        })
        : null}
    </>
  );
}

function FullscreenControl() {
  const map = useMap();
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const update = () => setIsFullscreen(document.fullscreenElement === map.getContainer());
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, [map]);

  const toggleFullscreen = async () => {
    const container = map.getContainer();
    if (document.fullscreenElement === container) {
      await document.exitFullscreen();
    } else {
      await container.requestFullscreen();
      window.setTimeout(() => map.invalidateSize(), 100);
    }
  };

  return (
    <button
      type="button"
      className="farm-map-fullscreen"
      aria-label={isFullscreen ? 'Exit fullscreen map' : 'View fullscreen map'}
      title={isFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
      onClick={() => void toggleFullscreen()}
    >
      <Maximize size={17} />
    </button>
  );
}

function InteractiveBoundary({
  boundary,
  tool,
  selectedVertex,
  onBoundaryChange,
  onToolChange,
  onSelectedVertexChange,
}: Pick<FarmMapProps, 'boundary' | 'tool' | 'selectedVertex' | 'onBoundaryChange' | 'onToolChange' | 'onSelectedVertexChange'>) {
  const removeVertex = (index: number, event: LeafletMouseEvent) => {
    L.DomEvent.stopPropagation(event.originalEvent);
    onBoundaryChange(boundary.filter((_, vertexIndex) => vertexIndex !== index));
    onSelectedVertexChange(null);
  };

  const addIntermediateVertex = (segmentIndex: number, event: LeafletMouseEvent) => {
    L.DomEvent.stopPropagation(event.originalEvent);
    const next = [...boundary];
    next.splice(segmentIndex + 1, 0, toGeoPoint(event.latlng.lat, event.latlng.lng));
    onBoundaryChange(next);
    onSelectedVertexChange(segmentIndex + 1);
  };

  const points = boundary.map(pointToLatLng);

  return (
    <>
      {boundary.length >= 3 ? (
        <Polygon
          positions={points}
          pathOptions={{ color: '#388e49', interactive: false, weight: 3, fillColor: '#8bcb88', fillOpacity: 0.28 }}
        />
      ) : boundary.length === 2 ? (
        <Polyline positions={points} pathOptions={{ color: '#388e49', weight: 3 }} />
      ) : null}
      {boundary.map((point, index) => (
        <Marker
          key={`boundary-${index}-${point.latitude}-${point.longitude}`}
          position={pointToLatLng(point)}
          icon={vertexIcon(selectedVertex === index)}
          draggable={tool === 'editing'}
          eventHandlers={{
            click(event) {
              L.DomEvent.stopPropagation(event.originalEvent);
              if (tool === 'drawing' && index === 0 && boundary.length >= 3) onToolChange('idle');
              else if (tool === 'editing') onSelectedVertexChange(index);
            },
            contextmenu(event) {
              removeVertex(index, event);
            },
            dragend(event) {
              const { lat, lng } = event.target.getLatLng();
              onBoundaryChange(boundary.map((current, vertexIndex) => vertexIndex === index
                ? toGeoPoint(lat, lng)
                : current));
            },
          }}
          zIndexOffset={selectedVertex === index ? 1000 : 0}
        />
      ))}
      {tool === 'editing' && boundary.length >= 3
        ? boundary.map((point, index) => {
          const nextPoint = boundary[(index + 1) % boundary.length];
          const midpoint: [number, number] = [
            (point.latitude + nextPoint.latitude) / 2,
            (point.longitude + nextPoint.longitude) / 2,
          ];
          return (
            <CircleMarker
              key={`boundary-insert-${index}`}
              center={midpoint}
              radius={7}
              pathOptions={{
                color: '#ffffff',
                weight: 2,
                fillColor: '#f0be4c',
                fillOpacity: 1,
                bubblingMouseEvents: false,
              }}
              eventHandlers={{
                click(event) {
                  addIntermediateVertex(index, event);
                },
              }}
            />
          );
        })
        : null}
    </>
  );
}

function CurrentLocationMarker({
  location,
  onLocationChange,
}: {
  location: FarmLocation;
  onLocationChange: (location: FarmLocation) => void;
}) {
  return (
    <Marker
      position={pointToLatLng(location)}
      icon={locationIcon}
      draggable
      eventHandlers={{
        dragend(event) {
          const { lat, lng } = event.target.getLatLng();
          onLocationChange({ ...toGeoPoint(lat, lng), formattedAddress: 'Selected map location' });
        },
      }}
    />
  );
}

function MapLayer({
  mapType,
  onMapTilerError,
}: {
  mapType: MapViewType;
  onMapTilerError: () => void;
}) {
  const usingMapTiler = hasMapTilerKey && mapType !== 'roadmap';
  const mapStyle = mapType === 'hybrid' ? 'hybrid' : 'satellite';
  const url = usingMapTiler
    ? `https://api.maptiler.com/maps/${mapStyle}/{z}/{x}/{y}.jpg?key=${encodeURIComponent(mapTilerApiKey)}`
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

  return (
    <TileLayer
      key={`${usingMapTiler ? 'maptiler' : 'osm'}-${mapStyle}`}
      url={url}
      maxZoom={usingMapTiler ? 20 : 19}
      attribution={usingMapTiler ? MAPTILER_ATTRIBUTION : OSM_ATTRIBUTION}
      eventHandlers={usingMapTiler ? { tileerror: onMapTilerError } : undefined}
    />
  );
}

function MapTilerLogo() {
  return (
    <a className="farm-map-maptiler-logo" href="https://www.maptiler.com/" target="_blank" rel="noreferrer" aria-label="MapTiler">
      <img src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler logo" />
    </a>
  );
}

function LeafletMap({
  location,
  boundary,
  mapType,
  tool,
  selectedVertex,
  onLocationChange,
  onBoundaryChange,
  onMapTypeChange,
  onToolChange,
  onSelectedVertexChange,
  landUseRegions = [],
  digitizer,
  onMapTilerError,
  mapTilerUnavailable,
}: FarmMapProps & {
  onMapTilerError: () => void;
  mapTilerUnavailable: boolean;
}) {
  const effectiveMapType: MapViewType = hasMapTilerKey && !mapTilerUnavailable ? mapType : 'roadmap';
  const visibleNotice = mapTilerUnavailable
    ? 'MapTiler satellite tiles failed to load; OpenStreetMap is shown instead. Check your API key, account limits, and network.'
    : !hasMapTilerKey
      ? 'MapTiler satellite imagery requires a free MapTiler API key. Add VITE_MAPTILER_API_KEY to .env; OpenStreetMap is shown as the working fallback.'
      : '';
  const initialCenter = pointToLatLng(location) || EGYPT_CENTER;

  const chooseLocation = (suggestion: SearchSuggestion) => {
    onLocationChange({ ...suggestion.point, formattedAddress: suggestion.label });
  };

  return (
    <div className="farm-map">
      {visibleNotice ? <div className="farm-map-provider-note">{visibleNotice}</div> : null}
      <div className="farm-map-view">
        <MapSearch location={location} onChoose={chooseLocation} />
        <MapTypeSelector
          activeMapType={effectiveMapType}
          onMapTypeChange={onMapTypeChange}
          satelliteAvailable={hasMapTilerKey && !mapTilerUnavailable}
        />
        <MapContainer
          center={initialCenter}
          zoom={location.formattedAddress === 'Egypt' ? 6 : 13}
          zoomControl={false}
          scrollWheelZoom
          maxZoom={20}
          className="farm-map-canvas"
          aria-label="Interactive farm map"
        >
          <MapLayer
            mapType={effectiveMapType}
            onMapTilerError={onMapTilerError}
          />
          <ZoomControl position="topright" />
          <MapEvents
            location={location}
            boundary={boundary}
            tool={tool}
            digitizer={digitizer}
            onLocationChange={onLocationChange}
            onBoundaryChange={onBoundaryChange}
            onSelectedVertexChange={onSelectedVertexChange}
          />
          <FullscreenControl />
          {tool === 'location'
            ? <CurrentLocationMarker location={location} onLocationChange={onLocationChange} />
            : null}
          <InteractiveBoundary
            boundary={boundary}
            tool={tool}
            selectedVertex={selectedVertex}
            onBoundaryChange={onBoundaryChange}
            onToolChange={onToolChange}
            onSelectedVertexChange={onSelectedVertexChange}
          />
          <LandUseLayer regions={landUseRegions} digitizer={digitizer} />
        </MapContainer>
        {effectiveMapType !== 'roadmap' ? <MapTilerLogo /> : null}
        <div className="farm-map-attribution-note">
          {effectiveMapType === 'roadmap'
            ? 'OpenStreetMap road map'
            : `MapTiler ${effectiveMapType === 'hybrid' ? 'Hybrid' : 'Satellite'}`}
        </div>
      </div>
    </div>
  );
}

export default function FarmMap(props: FarmMapProps) {
  const [mapTilerUnavailable, setMapTilerUnavailable] = useState(false);
  const onMapTilerError = () => setMapTilerUnavailable(true);

  return (
    <LeafletMap
      {...props}
      onMapTilerError={onMapTilerError}
      mapTilerUnavailable={mapTilerUnavailable}
    />
  );
}
