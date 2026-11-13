import { useEffect, useMemo, useRef, useState } from 'react';
import { Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GeoPoint, MapViewType } from './FarmMap';
import type { LandUseRegion } from './landUse';
import type { GeographicImageBounds } from './processedImagery';

export type SatelliteProvider = 'maptiler' | 'mapbox';
type ImageryProvider = 'MapTiler Satellite' | 'MapTiler Hybrid' | 'Mapbox Satellite' | 'OpenStreetMap';

export type ImageryState =
  | { status: 'off'; provider: null; zoom: null; maxZoom: null; message: string }
  | { status: 'loading'; provider: ImageryProvider | null; zoom: number | null; maxZoom: number | null; message: string }
  | { status: 'ready'; provider: ImageryProvider; zoom: number; maxZoom: number | null; message: string }
  | { status: 'error'; provider: null; zoom: number | null; maxZoom: number | null; message: string };

export interface FarmDigitalTwinProps {
  coordinates: GeoPoint[];
  mapType: MapViewType;
  satelliteProvider: SatelliteProvider;
  zoomLevel: number;
  landUseRegions: LandUseRegion[];
  processedImagery?: { url: string; bounds: GeographicImageBounds };
  onProcessedImageryStateChange?: (message: string) => void;
  mapTilerApiKey: string;
  mapboxAccessToken: string;
  onImageryStateChange: (state: ImageryState) => void;
  showSatelliteImage?: boolean;
  showTerrain?: boolean;
  showCropPrototype?: boolean;
  showPlots?: boolean;
  showInfrastructure?: boolean;
}

interface ProjectedPoint {
  x: number;
  y: number;
}

interface TileMosaic {
  canvas: HTMLCanvasElement;
  columns: number;
  rows: number;
  minTileX: number;
  minTileY: number;
  zoom: number;
  tileSize: number;
  provider: ImageryProvider;
}

interface ContextBounds {
  width: number;
  depth: number;
  x: number;
  z: number;
}

function TerrainSurface({ size }: { size: number }) {
  const layout = useMemo(() => {
    const scale = size / 100;
    const soilColors = ['#806748', '#8a7050', '#765f43', '#886e4c'];
    const plots = [-1, 1].flatMap((column) => [-1, 1].map((row, plotIndex) => {
      const width = 43 * scale;
      const depth = 41 * scale;
      const geometry = new THREE.PlaneGeometry(
        width,
        depth,
        Math.ceil(width / (0.45 * scale)),
        Math.ceil(depth / (0.45 * scale)),
      );
      const positions = geometry.attributes.position as THREE.BufferAttribute;
      for (let vertex = 0; vertex < positions.count; vertex += 1) {
        const x = positions.getX(vertex);
        const z = positions.getY(vertex);
        const acrossRows = (plotIndex === 0 ? x : z) / scale;
        const furrow = Math.cos(acrossRows * 3.5) * 0.095 * scale;
        const soilVariation = (
          Math.sin(x * 1.7 + z * 0.4) * Math.cos(z * 1.2 - x * 0.3)
        ) * 0.018 * scale;
        positions.setZ(vertex, furrow + soilVariation);
      }
      geometry.rotateX(-Math.PI / 2);
      geometry.computeVertexNormals();
      return {
        id: `${column}-${row}`,
        geometry,
        position: [column * 23.2 * scale, 0.04 * scale, row * 22 * scale] as [number, number, number],
        color: soilColors[(column > 0 ? 1 : 0) + (row > 0 ? 2 : 0)],
      };
    }));

    return {
      scale,
      plots,
      ground: new THREE.PlaneGeometry(size * 4, size * 4, 48, 48),
      fieldBase: new THREE.BoxGeometry(96 * scale, 0.45 * scale, 92 * scale),
      paths: [
        { position: [0, 0.012 * scale, 0] as [number, number, number], size: [96 * scale, 0.05 * scale, 4.2 * scale] as [number, number, number] },
        { position: [0, 0.014 * scale, 0] as [number, number, number], size: [4.2 * scale, 0.055 * scale, 92 * scale] as [number, number, number] },
        { position: [0, 0.012 * scale, -45.2 * scale] as [number, number, number], size: [96 * scale, 0.11 * scale, 1.5 * scale] as [number, number, number] },
        { position: [0, 0.012 * scale, 45.2 * scale] as [number, number, number], size: [96 * scale, 0.11 * scale, 1.5 * scale] as [number, number, number] },
        { position: [-47.2 * scale, 0.012 * scale, 0] as [number, number, number], size: [1.5 * scale, 0.11 * scale, 90 * scale] as [number, number, number] },
        { position: [47.2 * scale, 0.012 * scale, 0] as [number, number, number], size: [1.5 * scale, 0.11 * scale, 90 * scale] as [number, number, number] },
      ],
      berms: [
        { position: [0, 0.22 * scale, -46 * scale] as [number, number, number], size: [98 * scale, 0.48 * scale, 1.5 * scale] as [number, number, number] },
        { position: [0, 0.22 * scale, 46 * scale] as [number, number, number], size: [98 * scale, 0.48 * scale, 1.5 * scale] as [number, number, number] },
        { position: [-48 * scale, 0.22 * scale, 0] as [number, number, number], size: [1.5 * scale, 0.48 * scale, 92 * scale] as [number, number, number] },
        { position: [48 * scale, 0.22 * scale, 0] as [number, number, number], size: [1.5 * scale, 0.48 * scale, 92 * scale] as [number, number, number] },
      ],
      channels: [
        { position: [0, 0.07 * scale, 0] as [number, number, number], size: [96 * scale, 0.025 * scale, 1.25 * scale] as [number, number, number] },
        { position: [0, 0.075 * scale, 0] as [number, number, number], size: [1.25 * scale, 0.03 * scale, 92 * scale] as [number, number, number] },
      ],
      sourceCanal: new THREE.BoxGeometry(7.5 * scale, 0.06 * scale, 94 * scale),
      sourceBanks: new THREE.BoxGeometry(10 * scale, 0.5 * scale, 96 * scale),
    };
  }, [size]);

  useEffect(() => () => {
    layout.ground.dispose();
    layout.fieldBase.dispose();
    layout.plots.forEach((plot) => plot.geometry.dispose());
    layout.sourceCanal.dispose();
    layout.sourceBanks.dispose();
  }, [layout]);

  const scale = layout.scale;
  return (
    <group>
      <mesh geometry={layout.ground} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.38 * scale, 0]} receiveShadow>
        <meshStandardMaterial color="#46583a" roughness={1} />
      </mesh>
      <mesh geometry={layout.fieldBase} position={[0, -0.22 * scale, 0]} receiveShadow castShadow>
        <meshStandardMaterial color="#574432" roughness={0.98} />
      </mesh>
      {layout.plots.map((plot) => (
        <mesh key={plot.id} geometry={plot.geometry} position={plot.position} receiveShadow castShadow>
          <meshStandardMaterial color={plot.color} roughness={0.96} />
        </mesh>
      ))}
      {layout.paths.map((path, index) => (
        <mesh key={`path-${index}`} position={path.position} receiveShadow>
          <boxGeometry args={path.size} />
          <meshStandardMaterial color={index < 2 ? '#79664f' : '#a08c6b'} roughness={0.94} />
        </mesh>
      ))}
      {layout.berms.map((berm, index) => (
        <mesh key={`berm-${index}`} position={berm.position} receiveShadow castShadow>
          <boxGeometry args={berm.size} />
          <meshStandardMaterial color="#59402b" roughness={0.98} />
        </mesh>
      ))}
      <mesh geometry={layout.sourceBanks} position={[-53 * scale, -0.1 * scale, 0]} receiveShadow castShadow>
        <meshStandardMaterial color="#483522" roughness={0.95} />
      </mesh>
      <mesh geometry={layout.sourceCanal} position={[-53 * scale, 0.16 * scale, 0]}>
        <meshStandardMaterial color="#126c87" roughness={0.18} metalness={0.12} />
      </mesh>
      {layout.channels.map((channel, index) => (
        <mesh key={`channel-${index}`} position={channel.position}>
          <boxGeometry args={channel.size} />
          <meshStandardMaterial color="#1682a1" roughness={0.2} metalness={0.12} />
        </mesh>
      ))}
    </group>
  );
}

function CropPrototype({ cropType, position, scale = 1 }: {
  cropType: 'wheat' | 'corn' | 'rice' | 'tomato' | 'potato' | 'cotton';
  position: [number, number, number];
  scale?: number;
}) {
  const seeds: Array<{ key: string; position: [number, number, number]; rotation: [number, number, number]; scale: number }> = [];

  const makeStems = (count: number, height: number, color: string) => Array.from({ length: count }).map((_, index) => ({
    key: `${cropType}-${index}`,
    position: [
      (index % 3) * 0.14 - 0.2,
      0,
      Math.floor(index / 3) * 0.14 - 0.2,
    ] as [number, number, number],
    rotation: [0, (index / count) * Math.PI * 2, 0] as [number, number, number],
    height,
    color,
  }));

  switch (cropType) {
    case 'wheat':
      seeds.push(...makeStems(7, 0.82, '#8fd96f').map((stem) => ({
        ...stem,
        key: `wheat-${stem.key}`,
        position: [stem.position[0], 0, stem.position[2]] as [number, number, number],
        scale: 1,
      })));
      return (
        <group position={position} scale={scale}>
          {seeds.map((seed) => (
            <group key={seed.key} position={seed.position} rotation={seed.rotation}>
              <mesh castShadow position={[0, seed.height / 2, 0]}>
                <cylinderGeometry args={[0.02, 0.04, seed.height, 8]} />
                <meshStandardMaterial color="#619a53" />
              </mesh>
              <mesh castShadow position={[0, seed.height + 0.04, 0]}>
                <coneGeometry args={[0.08, 0.22, 10]} />
                <meshStandardMaterial color="#d8d38d" />
              </mesh>
              {[-0.08, 0.08].map((offset) => (
                <mesh key={offset} castShadow position={[offset, seed.height * 0.7, 0]} rotation={[0, 0, offset * 2]}>
                  <boxGeometry args={[0.18, 0.05, 0.04]} />
                  <meshStandardMaterial color="#74ba5d" />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      );
    case 'corn':
      return (
        <group position={position} scale={scale}>
          {Array.from({ length: 6 }).map((_, index) => (
            <group key={`corn-${index}`} position={[(index % 3) * 0.25 - 0.25, 0, Math.floor(index / 3) * 0.25 - 0.25]}>
              <mesh castShadow position={[0, 0.55, 0]}>
                <cylinderGeometry args={[0.05, 0.08, 1.1, 8]} />
                <meshStandardMaterial color="#5d9d4a" />
              </mesh>
              {[-0.12, 0.12].map((offset) => (
                <mesh key={offset} castShadow position={[offset, 0.7, 0]} rotation={[0, 0, offset * 2.8]}>
                  <boxGeometry args={[0.3, 0.06, 0.09]} />
                  <meshStandardMaterial color="#7cc265" />
                </mesh>
              ))}
              <mesh castShadow position={[0, 1.08, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.12, 0.12, 0.25, 12]} />
                <meshStandardMaterial color="#d7c35f" />
              </mesh>
            </group>
          ))}
        </group>
      );
    case 'rice':
      return (
        <group position={position} scale={scale}>
          {Array.from({ length: 12 }).map((_, index) => (
            <group key={`rice-${index}`} position={[(index % 4) * 0.18 - 0.28, 0, Math.floor(index / 4) * 0.18 - 0.28]}>
              <mesh castShadow position={[0, 0.55, 0]}>
                <cylinderGeometry args={[0.02, 0.03, 1.1, 8]} />
                <meshStandardMaterial color="#59a767" />
              </mesh>
              {[-0.09, 0.09].map((offset) => (
                <mesh key={offset} castShadow position={[offset * 0.8, 0.7, 0]} rotation={[0, 0, offset * 2.2]}>
                  <boxGeometry args={[0.2, 0.04, 0.04]} />
                  <meshStandardMaterial color="#85d17e" />
                </mesh>
              ))}
              <mesh castShadow position={[0, 1.02, 0]}>
                <sphereGeometry args={[0.08, 8, 8]} />
                <meshStandardMaterial color="#dce8a4" />
              </mesh>
            </group>
          ))}
        </group>
      );
    case 'tomato':
      return (
        <group position={position} scale={scale}>
          {Array.from({ length: 5 }).map((_, index) => (
            <group key={`tomato-${index}`} position={[(index % 3) * 0.26 - 0.26, 0, Math.floor(index / 3) * 0.28 - 0.28]}>
              <mesh castShadow position={[0, 0.32, 0]}>
                <cylinderGeometry args={[0.025, 0.035, 0.64, 8]} />
                <meshStandardMaterial color="#2e7d49" />
              </mesh>
              {[-0.12, 0.12].map((offset) => (
                <mesh key={offset} castShadow position={[offset, 0.48, 0]} rotation={[0, 0, offset * 2.6]}>
                  <boxGeometry args={[0.18, 0.04, 0.04]} />
                  <meshStandardMaterial color="#4da666" />
                </mesh>
              ))}
              {Array.from({ length: 4 }).map((__, fruitIndex) => (
                <mesh key={`fruit-${fruitIndex}`} castShadow position={[(fruitIndex - 1.5) * 0.08, 0.72 + (fruitIndex % 2) * 0.06, 0.02]}>
                  <sphereGeometry args={[0.09, 10, 10]} />
                  <meshStandardMaterial color={fruitIndex % 2 === 0 ? '#e75e4f' : '#c53c35'} />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      );
    case 'potato':
      return (
        <group position={position} scale={scale}>
          {Array.from({ length: 6 }).map((_, index) => (
            <group key={`potato-${index}`} position={[(index % 3) * 0.22 - 0.22, 0, Math.floor(index / 3) * 0.22 - 0.22]}>
              <mesh castShadow position={[0, 0.2, 0]}>
                <cylinderGeometry args={[0.03, 0.04, 0.4, 8]} />
                <meshStandardMaterial color="#5f9d58" />
              </mesh>
              {[-0.15, 0.15].map((offset) => (
                <mesh key={offset} castShadow position={[offset, 0.36, 0]} rotation={[0, 0, offset * 2.3]}>
                  <boxGeometry args={[0.22, 0.05, 0.05]} />
                  <meshStandardMaterial color="#76b55f" />
                </mesh>
              ))}
              {Array.from({ length: 3 }).map((__, tuberIndex) => (
                <mesh key={`tuber-${tuberIndex}`} castShadow position={[(tuberIndex - 1) * 0.1, 0.06, 0.08 * (tuberIndex - 1)]}>
                  <sphereGeometry args={[0.09, 10, 10]} />
                  <meshStandardMaterial color="#d8b16c" />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      );
    case 'cotton':
      return (
        <group position={position} scale={scale}>
          {Array.from({ length: 5 }).map((_, index) => (
            <group key={`cotton-${index}`} position={[(index % 3) * 0.25 - 0.25, 0, Math.floor(index / 3) * 0.25 - 0.25]}>
              <mesh castShadow position={[0, 0.45, 0]}>
                <cylinderGeometry args={[0.04, 0.05, 0.9, 8]} />
                <meshStandardMaterial color="#4c8f53" />
              </mesh>
              {[-0.12, 0.12].map((offset) => (
                <mesh key={offset} castShadow position={[offset, 0.7, 0]} rotation={[0, 0, offset * 2.6]}>
                  <boxGeometry args={[0.26, 0.06, 0.06]} />
                  <meshStandardMaterial color="#6fb75b" />
                </mesh>
              ))}
              {Array.from({ length: 5 }).map((__, puffIndex) => (
                <mesh key={`puff-${puffIndex}`} castShadow position={[(puffIndex - 2) * 0.08, 0.95 + (puffIndex % 2) * 0.04, 0.04 * (puffIndex - 2)]}>
                  <sphereGeometry args={[0.08, 10, 10]} />
                  <meshStandardMaterial color="#f2f0e7" roughness={0.9} />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      );
    default:
      return null;
  }
}

function CropPrototypeLibrary({ size }: { size: number }) {
  const positions: Array<[number, number, number]> = [
    [size * 0.66, 0.06, size * 0.32],
    [size * 0.8, 0.06, -size * 0.24],
    [-size * 0.72, 0.06, size * 0.18],
    [-size * 0.8, 0.06, -size * 0.38],
    [size * 0.2, 0.06, -size * 0.78],
    [-size * 0.18, 0.06, size * 0.88],
  ];
  const cropTypes: Array<'wheat' | 'corn' | 'rice' | 'tomato' | 'potato' | 'cotton'> = ['wheat', 'corn', 'rice', 'tomato', 'potato', 'cotton'];

  return (
    <group position={[0, 0, 0]}>
      {positions.map((position, index) => (
        <CropPrototype key={cropTypes[index]} cropType={cropTypes[index]} position={position} scale={1.3 + (index % 3) * 0.15} />
      ))}
    </group>
  );
}

function IrrigationRegionSurface({ region, center }: {
  region: LandUseRegion;
  center: ProjectedPoint;
}) {
  const points = useMemo(() => region.coordinates.map((point) => {
    const projected = projectGeographicPoint(point);
    return new THREE.Vector3(projected.x - center.x, 0.13, -(projected.y - center.y));
  }), [center, region.coordinates]);
  const pipeGeometry = useMemo(() => {
    if (points.length < 2) return new THREE.BufferGeometry();
    const route = new THREE.CurvePath<THREE.Vector3>();
    points.slice(1).forEach((point, index) => {
      route.add(new THREE.LineCurve3(points[index], point));
    });
    return new THREE.TubeGeometry(route, Math.max(16, points.length * 12), 0.12, 8, false);
  }, [points]);

  useEffect(() => () => pipeGeometry.dispose(), [pipeGeometry]);

  if (points.length < 2) return null;
  return (
    <>
      <mesh geometry={pipeGeometry} castShadow receiveShadow>
        <meshStandardMaterial color="#087eaa" roughness={0.38} metalness={0.22} />
      </mesh>
      <Line
        points={points.map((point) => new THREE.Vector3(point.x, 0.22, point.z))}
        color="#7be8ff"
        lineWidth={1.5}
      />
    </>
  );
}

function LandUseRegionSurface({ region, center }: {
  region: LandUseRegion;
  center: ProjectedPoint;
}) {
  if (region.kind === 'irrigation') return <IrrigationRegionSurface region={region} center={center} />;
  return <LandUsePolygonSurface region={region} center={center} />;
}

function LandUsePolygonSurface({ region, center }: {
  region: LandUseRegion;
  center: ProjectedPoint;
}) {
  const projected = useMemo(() => region.coordinates.map(projectGeographicPoint), [region.coordinates]);
  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    if (projected.length < 3) return new THREE.ShapeGeometry(shape);
    shape.moveTo(projected[0].x - center.x, projected[0].y - center.y);
    projected.slice(1).forEach((point) => shape.lineTo(point.x - center.x, point.y - center.y));
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }, [center, projected]);
  const bedLineGeometries = useMemo(() => {
    const furrows = new THREE.BufferGeometry();
    const ridges = new THREE.BufferGeometry();
    if (region.kind !== 'plot' || projected.length < 3) return { furrows, ridges };

    let longestEdgeAngle = 0;
    let longestEdgeLength = 0;
    for (let index = 0; index < projected.length; index += 1) {
      const start = projected[index];
      const end = projected[(index + 1) % projected.length];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length > longestEdgeLength) {
        longestEdgeLength = length;
        longestEdgeAngle = Math.atan2(dy, dx);
      }
    }

    const axisX = Math.cos(longestEdgeAngle);
    const axisY = Math.sin(longestEdgeAngle);
    const normalX = -axisY;
    const normalY = axisX;
    const coordinates = projected.map((point) => ({
      along: point.x * axisX + point.y * axisY,
      across: point.x * normalX + point.y * normalY,
    }));
    const minAcross = Math.min(...coordinates.map((point) => point.across));
    const maxAcross = Math.max(...coordinates.map((point) => point.across));
    const acrossWidth = maxAcross - minAcross;
    const furrowCount = Math.min(56, Math.max(8, Math.floor(acrossWidth / 1.8)));
    const furrowSpacing = acrossWidth / furrowCount;
    const furrowVertices: number[] = [];
    const ridgeVertices: number[] = [];

    for (let row = 0; row < furrowCount; row += 1) {
      const rowCenter = minAcross + (row + 0.5) * furrowSpacing;
      for (const [offset, target, height] of [
        [0, furrowVertices, 0.082],
        [-furrowSpacing * 0.22, ridgeVertices, 0.088],
        [furrowSpacing * 0.22, ridgeVertices, 0.088],
      ] as const) {
        const across = rowCenter + offset;
        const intersections: number[] = [];
        for (let index = 0; index < coordinates.length; index += 1) {
          const start = coordinates[index];
          const end = coordinates[(index + 1) % coordinates.length];
          if ((start.across <= across && end.across > across)
            || (end.across <= across && start.across > across)) {
            const ratio = (across - start.across) / (end.across - start.across);
            intersections.push(start.along + ratio * (end.along - start.along));
          }
        }
        intersections.sort((left, right) => left - right);

        for (let index = 0; index + 1 < intersections.length; index += 2) {
          const startAlong = intersections[index];
          const endAlong = intersections[index + 1];
          if (endAlong - startAlong < 0.5) continue;
          for (const along of [startAlong, endAlong]) {
            const x = along * axisX + across * normalX - center.x;
            const y = along * axisY + across * normalY - center.y;
            target.push(x, height, -y);
          }
        }
      }
    }

    furrows.setAttribute('position', new THREE.Float32BufferAttribute(furrowVertices, 3));
    ridges.setAttribute('position', new THREE.Float32BufferAttribute(ridgeVertices, 3));
    return { furrows, ridges };
  }, [center, projected, region.kind]);
  const style = useMemo(() => {
    if (region.kind === 'plot') return { fill: '#a87945', line: '#dfc99d', opacity: 0.32 };
    switch (region.excludedType) {
      case 'road': return { fill: '#b7a88f', line: '#f0d7ab', opacity: 0.48 };
      case 'path': return { fill: '#c4b799', line: '#f4e3bf', opacity: 0.38 };
      case 'canal': return { fill: '#158eae', line: '#5be2ff', opacity: 0.58 };
      case 'building': return { fill: '#c88858', line: '#ffd0a1', opacity: 0.52 };
      case 'water': return { fill: '#1474a5', line: '#75d9ff', opacity: 0.56 };
      default: return { fill: '#b55245', line: '#ff9586', opacity: 0.45 };
    }
  }, [region.excludedType, region.kind]);
  const linePoints = useMemo(() => projected.length
    ? [...projected, projected[0]].map((point) => [
      point.x - center.x,
      0.1,
      -(point.y - center.y),
    ] as [number, number, number])
    : [], [center, projected]);

  useEffect(() => () => {
    geometry.dispose();
    bedLineGeometries.furrows.dispose();
    bedLineGeometries.ridges.dispose();
  }, [bedLineGeometries, geometry]);

  if (projected.length < 3) return null;
  return (
    <>
      <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.068, 0]} renderOrder={2}>
        <meshBasicMaterial
          color={style.fill}
          transparent
          opacity={style.opacity}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {region.kind === 'plot' ? (
        <>
          <lineSegments geometry={bedLineGeometries.ridges} renderOrder={3}>
            <lineBasicMaterial color="#e0c18c" transparent opacity={0.34} depthWrite={false} />
          </lineSegments>
          <lineSegments geometry={bedLineGeometries.furrows} renderOrder={4}>
            <lineBasicMaterial color="#60452e" transparent opacity={0.46} depthWrite={false} />
          </lineSegments>
        </>
      ) : null}
      <Line points={linePoints.map(([x, y, z]) => [x, y + 0.025, z])} color={style.line} lineWidth={region.excludedType === 'canal' ? 3 : 2} />
    </>
  );
}

function ProcessedFarmSurface({
  coordinates,
  center,
  imagery,
  onStateChange,
}: {
  coordinates: GeoPoint[];
  center: ProjectedPoint;
  imagery: { url: string; bounds: GeographicImageBounds };
  onStateChange?: (message: string) => void;
}) {
  const { invalidate } = useThree();
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const projected = useMemo(() => coordinates.map(projectGeographicPoint), [coordinates]);
  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    if (projected.length < 3) return new THREE.ShapeGeometry(shape);
    shape.moveTo(projected[0].x - center.x, projected[0].y - center.y);
    projected.slice(1).forEach((point) => shape.lineTo(point.x - center.x, point.y - center.y));
    shape.closePath();
    const shapeGeometry = new THREE.ShapeGeometry(shape);
    const west = projectGeographicPoint({ latitude: 0, longitude: imagery.bounds.west }).x;
    const east = projectGeographicPoint({ latitude: 0, longitude: imagery.bounds.east }).x;
    const south = projectGeographicPoint({ latitude: imagery.bounds.south, longitude: 0 }).y;
    const north = projectGeographicPoint({ latitude: imagery.bounds.north, longitude: 0 }).y;
    const position = shapeGeometry.getAttribute('position');
    const uv = shapeGeometry.getAttribute('uv');
    for (let index = 0; index < position.count; index += 1) {
      const worldX = position.getX(index) + center.x;
      const worldY = position.getY(index) + center.y;
      uv.setXY(index, (worldX - west) / (east - west), (worldY - south) / (north - south));
    }
    uv.needsUpdate = true;
    return shapeGeometry;
  }, [center, imagery.bounds, projected]);

  useEffect(() => {
    let active = true;
    onStateChange?.(`Loading processed image: ${imagery.url.split('/').pop() ?? 'local image'}.`);
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      const nextTexture = new THREE.Texture(image);
      nextTexture.colorSpace = THREE.SRGBColorSpace;
      nextTexture.generateMipmaps = true;
      nextTexture.minFilter = THREE.LinearMipmapLinearFilter;
      nextTexture.magFilter = THREE.LinearFilter;
      nextTexture.needsUpdate = true;
      setTexture((previous) => {
        previous?.dispose();
        return nextTexture;
      });
      onStateChange?.('Externally processed image loaded over the farm boundary. Original satellite tiles remain unchanged underneath.');
      invalidate();
    };
    image.onerror = () => {
      if (active) onStateChange?.('The processed image could not be decoded; original satellite imagery remains visible.');
    };
    image.src = imagery.url;
    return () => {
      active = false;
      image.src = '';
    };
  }, [imagery.url, invalidate, onStateChange]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => texture?.dispose(), [texture]);

  if (!texture) return null;
  return (
    <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.045, 0]}>
      <meshBasicMaterial map={texture} side={THREE.DoubleSide} />
    </mesh>
  );
}

const WEB_MERCATOR_RADIUS = 6_378_137;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const MAPTILER_TILE_SIZE = 512;
const OSM_TILE_SIZE = 256;
const MAX_MOSAIC_TILES = 64;
const MAX_TILE_ZOOM = 22;
const tileImageCache = new Map<string, HTMLImageElement>();
const mapboxTileJsonCache = new Map<string, Promise<number>>();

const projectGeographicPoint = (point: GeoPoint): ProjectedPoint => {
  const latitude = THREE.MathUtils.clamp(point.latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const latitudeRadians = THREE.MathUtils.degToRad(latitude);
  return {
    x: WEB_MERCATOR_RADIUS * THREE.MathUtils.degToRad(point.longitude),
    y: WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)),
  };
};

export const getFarmSceneSize = (coordinates: GeoPoint[]) => {
  const points = coordinates.map(projectGeographicPoint);
  if (!points.length) return 10;
  const width = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
  const depth = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
  return Math.max(width, depth, 10);
};

const getTileCoordinate = (x: number, y: number, zoom: number) => {
  const worldSize = 2 * Math.PI * WEB_MERCATOR_RADIUS;
  const tileWorldSize = worldSize / (2 ** zoom);
  return {
    tileX: Math.floor((x + worldSize / 2) / tileWorldSize),
    tileY: Math.floor((worldSize / 2 - y) / tileWorldSize),
  };
};

const getTileBounds = (points: ProjectedPoint[], zoom: number) => {
  const tileCoordinates = points.map((point) => getTileCoordinate(point.x, point.y, zoom));
  const minTileX = Math.min(...tileCoordinates.map((tile) => tile.tileX));
  const maxTileX = Math.max(...tileCoordinates.map((tile) => tile.tileX));
  const minTileY = Math.min(...tileCoordinates.map((tile) => tile.tileY));
  const maxTileY = Math.max(...tileCoordinates.map((tile) => tile.tileY));
  return {
    minTileX,
    maxTileX,
    minTileY,
    maxTileY,
    columns: maxTileX - minTileX + 1,
    rows: maxTileY - minTileY + 1,
  };
};

const getMaxZoomForExtent = (points: ProjectedPoint[], startingZoom: number, tileSize: number) => {
  let zoom = startingZoom;
  while (zoom > 12) {
    const { columns, rows } = getTileBounds(points, zoom);
    if (columns * rows <= MAX_MOSAIC_TILES
      && columns * tileSize <= 4096
      && rows * tileSize <= 4096) break;
    zoom -= 1;
  }
  return zoom;
};

const getMapboxMaxZoom = (accessToken: string) => {
  const cached = mapboxTileJsonCache.get(accessToken);
  if (cached) return cached;

  const metadataRequest = fetch(`https://api.mapbox.com/v4/mapbox.satellite.json?access_token=${encodeURIComponent(accessToken)}`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Mapbox imagery metadata request failed (${response.status}).`);
      const metadata = await response.json() as { maxzoom?: unknown };
      if (typeof metadata.maxzoom !== 'number' || !Number.isFinite(metadata.maxzoom)) {
        throw new Error('Mapbox imagery metadata did not include a valid maximum tile zoom.');
      }
      return metadata.maxzoom;
    });
  mapboxTileJsonCache.set(accessToken, metadataRequest);
  return metadataRequest;
};

const loadImage = async (url: string, cacheKey: string, signal: AbortSignal): Promise<HTMLImageElement> => {
  if (signal.aborted) {
    throw new DOMException('The imagery request was aborted.', 'AbortError');
  }

  const cachedImage = tileImageCache.get(cacheKey);
  if (cachedImage) return cachedImage;

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Map tile request failed with HTTP ${response.status}.`);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The browser could not decode a map tile.'));
      image.src = objectUrl;
    });
    tileImageCache.set(cacheKey, image);
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

const buildTileMosaic = async (
  points: ProjectedPoint[],
  zoom: number,
  provider: ImageryProvider,
  mapTilerApiKey: string,
  mapboxAccessToken: string,
  signal: AbortSignal,
): Promise<TileMosaic> => {
  const { minTileX, maxTileX, minTileY, maxTileY, columns, rows } = getTileBounds(points, zoom);
  const isMapbox = provider === 'Mapbox Satellite';
  const isMapTiler = provider === 'MapTiler Satellite' || provider === 'MapTiler Hybrid';
  const tileSize = isMapbox || isMapTiler ? MAPTILER_TILE_SIZE : OSM_TILE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = columns * tileSize;
  canvas.height = rows * tileSize;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not prepare the map imagery.');

  const tileRequests: Array<Promise<{ image: HTMLImageElement; x: number; y: number }>> = [];
  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      const url = isMapTiler
        ? `https://api.maptiler.com/maps/${provider === 'MapTiler Hybrid' ? 'hybrid' : 'satellite'}/${zoom}/${tileX}/${tileY}.jpg?key=${encodeURIComponent(mapTilerApiKey)}`
        : isMapbox
          ? `https://api.mapbox.com/v4/mapbox.satellite/${zoom}/${tileX}/${tileY}@2x.jpg90?access_token=${encodeURIComponent(mapboxAccessToken)}`
          : `https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`;
      const cacheKey = `${provider}/${zoom}/${tileX}/${tileY}`;
      tileRequests.push(loadImage(url, cacheKey, signal)
        .then((image) => ({ image, x: tileX - minTileX, y: tileY - minTileY })));
    }
  }

  const tileResults = await Promise.allSettled(tileRequests);
  if (signal.aborted) throw new DOMException('The imagery request was aborted.', 'AbortError');
  const failedTile = tileResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failedTile) throw failedTile.reason;
  const tiles = tileResults
    .filter((result): result is PromiseFulfilledResult<{ image: HTMLImageElement; x: number; y: number }> => result.status === 'fulfilled')
    .map((result) => result.value);
  tiles.forEach(({ image, x, y }) => context.drawImage(image, x * tileSize, y * tileSize, tileSize, tileSize));
  return { canvas, columns, rows, minTileX, minTileY, zoom, tileSize, provider };
};

function FarmImagerySurface({
  coordinates,
  mapType,
  satelliteProvider,
  zoomLevel,
  landUseRegions,
  plantingPlans,
  processedImagery,
  onProcessedImageryStateChange,
  mapTilerApiKey,
  mapboxAccessToken,
  onImageryStateChange,
  showSatelliteImage = false,
  showTerrain = true,
  showCropPrototype = true,
  showPlots = true,
  showInfrastructure = true,
}: FarmDigitalTwinProps) {
  const { invalidate } = useThree();
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null);
  const [contextBounds, setContextBounds] = useState<ContextBounds | null>(null);
  const textures = useRef(new Set<THREE.CanvasTexture>());
  const projected = useMemo(() => coordinates.map(projectGeographicPoint), [coordinates]);
  const initialZoom = useMemo(
    () => getMaxZoomForExtent(projected, 19, MAPTILER_TILE_SIZE),
    [projected],
  );
  const requestedZoom = Math.min(initialZoom + zoomLevel, MAX_TILE_ZOOM);
  const center = useMemo(() => ({
    x: projected.length ? projected.reduce((sum, point) => sum + point.x, 0) / projected.length : 0,
    y: projected.length ? projected.reduce((sum, point) => sum + point.y, 0) / projected.length : 0,
  }), [projected]);

  const shapeGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    if (projected.length < 3) return new THREE.ShapeGeometry(shape);

    shape.moveTo(projected[0].x - center.x, projected[0].y - center.y);
    projected.slice(1).forEach((point) => shape.lineTo(point.x - center.x, point.y - center.y));
    shape.closePath();

    const geometry = new THREE.ShapeGeometry(shape);
    const uv = geometry.getAttribute('uv');
    const position = geometry.getAttribute('position');
    for (let index = 0; index < position.count; index += 1) {
      uv.setXY(index, position.getX(index), position.getY(index));
    }
    return geometry;
  }, [center, projected]);

  useEffect(() => {
    if (!showSatelliteImage) {
      setTexture((previousTexture) => {
        previousTexture?.dispose();
        return null;
      });
      setContextBounds(null);
      onImageryStateChange({
        status: 'off',
        provider: null,
        zoom: null,
        maxZoom: null,
        message: 'Satellite imagery is off. A generated farm-field layout is shown instead.',
      });
      return;
    }

    if (coordinates.length < 3) {
      onImageryStateChange({
        status: 'error',
        provider: null,
        zoom: null,
        maxZoom: null,
        message: 'This farm has no valid boundary to display.',
      });
      return;
    }

    const controller = new AbortController();
    onImageryStateChange({
      status: 'loading',
      provider: satelliteProvider === 'mapbox' ? 'Mapbox Satellite' : 'MapTiler Satellite',
      zoom: requestedZoom,
      maxZoom: null,
      message: `Loading real imagery at tile zoom ${requestedZoom}…`,
    });

    const loadImagery = async () => {
      const hasMapTilerKey = mapTilerApiKey.length > 0 && !/^(your|replace|change|insert|<)/i.test(mapTilerApiKey);
      const hasMapboxToken = mapboxAccessToken.length > 0 && !/^(your|replace|change|insert|<)/i.test(mapboxAccessToken);
      const providers: Array<{ name: ImageryProvider; accessToken?: string }> = [];
      let selectionWarning = '';
      if (mapType === 'roadmap') {
        providers.push({ name: 'OpenStreetMap' });
      } else if (satelliteProvider === 'mapbox') {
        if (hasMapboxToken) {
          providers.push({ name: 'Mapbox Satellite', accessToken: mapboxAccessToken });
        } else {
          selectionWarning = 'Mapbox is unavailable because VITE_MAPBOX_ACCESS_TOKEN is missing; ';
        }
        if (hasMapTilerKey) providers.push({ name: 'MapTiler Satellite' });
        providers.push({ name: 'OpenStreetMap' });
      } else {
        if (hasMapTilerKey) {
          providers.push({ name: mapType === 'hybrid' ? 'MapTiler Hybrid' : 'MapTiler Satellite' });
        } else {
          selectionWarning = 'MapTiler is unavailable because VITE_MAPTILER_API_KEY is missing; ';
        }
        providers.push({ name: 'OpenStreetMap' });
      }

      let failure: unknown = null;
      const providerFailures: string[] = [];
      for (const { name: provider, accessToken } of providers) {
        try {
          const isMapbox = provider === 'Mapbox Satellite';
          const tileSize = provider === 'OpenStreetMap' ? OSM_TILE_SIZE : MAPTILER_TILE_SIZE;
          let providerMaxZoom: number | null = null;
          if (isMapbox && accessToken) {
            try {
              providerMaxZoom = await getMapboxMaxZoom(accessToken);
            } catch (error) {
              providerFailures.push(error instanceof Error ? error.message : 'Mapbox tile metadata is unavailable.');
            }
          }
          const providerBaseZoom = getMaxZoomForExtent(projected, 19, tileSize);
          const targetZoom = Math.min(requestedZoom, providerMaxZoom ?? MAX_TILE_ZOOM);
          const maximumExtentZoom = getMaxZoomForExtent(projected, targetZoom, tileSize);
          let mosaic: TileMosaic | null = null;
          let loadFailure: unknown = null;
          for (let zoom = maximumExtentZoom; zoom >= providerBaseZoom; zoom -= 1) {
            try {
              mosaic = await buildTileMosaic(
                projected,
                zoom,
                provider,
                mapTilerApiKey,
                accessToken ?? '',
                controller.signal,
              );
              break;
            } catch (error) {
              if (controller.signal.aborted) return;
              loadFailure = error;
            }
          }
          if (!mosaic) throw loadFailure instanceof Error ? loadFailure : new Error('No usable imagery tiles were returned.');
          if (controller.signal.aborted) return;

          const canvasTexture = new THREE.CanvasTexture(mosaic.canvas);
          canvasTexture.colorSpace = THREE.SRGBColorSpace;
          canvasTexture.anisotropy = 8;
          canvasTexture.generateMipmaps = true;
          canvasTexture.minFilter = THREE.LinearMipmapLinearFilter;
          canvasTexture.magFilter = THREE.LinearFilter;

          const uv = shapeGeometry.getAttribute('uv');
          const tileWorldSize = (2 * Math.PI * WEB_MERCATOR_RADIUS) / (2 ** mosaic.zoom);
          const mosaicLeft = mosaic.minTileX * tileWorldSize - Math.PI * WEB_MERCATOR_RADIUS;
          const mosaicTop = Math.PI * WEB_MERCATOR_RADIUS - mosaic.minTileY * tileWorldSize;
          const mosaicWidth = mosaic.columns * tileWorldSize;
          const mosaicDepth = mosaic.rows * tileWorldSize;
          for (let index = 0; index < uv.count; index += 1) {
            const localX = shapeGeometry.getAttribute('position').getX(index);
            const localY = shapeGeometry.getAttribute('position').getY(index);
            const worldX = localX + center.x;
            const worldY = localY + center.y;
            uv.setXY(
              index,
              (worldX - mosaicLeft) / (mosaic.columns * tileWorldSize),
              (worldY - (mosaicTop - mosaic.rows * tileWorldSize)) / (mosaic.rows * tileWorldSize),
            );
          }
          uv.needsUpdate = true;

          setTexture((previousTexture) => {
            if (previousTexture && previousTexture !== canvasTexture) {
              previousTexture.dispose();
              textures.current.delete(previousTexture);
            }
            textures.current.add(canvasTexture);
            return canvasTexture;
          });
          setContextBounds({
            width: mosaicWidth,
            depth: mosaicDepth,
            x: mosaicLeft + mosaicWidth / 2 - center.x,
            z: -(mosaicTop - mosaicDepth / 2 - center.y),
          });
          invalidate();
          const fallbackNotice = provider !== providers[0].name
            ? ` The selected provider was unavailable, so ${provider} is being used instead.${providerFailures.length ? ` ${providerFailures.join(' ')}` : ''}`
            : '';
          const maxZoomLabel = providerMaxZoom === null ? 'provider maximum unknown' : `provider tile maximum z${providerMaxZoom}`;
          const message = `${selectionWarning}${provider} imagery loaded at tile zoom z${mosaic.zoom} (${maxZoomLabel}; native image resolution unknown). Elevation data is not connected, so the land remains flat.${fallbackNotice}`;
          onImageryStateChange({ status: 'ready', provider, zoom: mosaic.zoom, maxZoom: providerMaxZoom, message });
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          failure = error;
          providerFailures.push(`${provider} tiles are unavailable: ${error instanceof Error ? error.message : 'unknown tile request error'}`);
        }
      }

      if (!controller.signal.aborted) {
        onImageryStateChange({
          status: 'error',
          provider: null,
          zoom: null,
          maxZoom: null,
          message: failure instanceof Error
            ? `${selectionWarning}Map imagery could not be loaded: ${[...providerFailures, failure.message].join(' ')} Check the connection and configured imagery token.`
            : `${selectionWarning}Map imagery could not be loaded: ${providerFailures.join(' ')} Check the connection and configured imagery token.`,
        });
      }
    };

    void loadImagery();
    return () => {
      controller.abort();
    };
  }, [
    center,
    coordinates.length,
    initialZoom,
    invalidate,
    mapType,
    mapTilerApiKey,
    mapboxAccessToken,
    onImageryStateChange,
    projected,
    requestedZoom,
    satelliteProvider,
    showSatelliteImage,
    shapeGeometry,
  ]);

  useEffect(() => () => {
    textures.current.forEach((currentTexture) => currentTexture.dispose());
    textures.current.clear();
  }, []);

  useEffect(() => () => shapeGeometry.dispose(), [shapeGeometry]);

  const boundaryLine = useMemo(
    () => projected.length
      ? [...projected, projected[0]].map((point) => [
        point.x - center.x,
        0.08,
        -(point.y - center.y),
      ] as [number, number, number])
      : [],
    [center, projected],
  );
  const terrainSize = 100;

  return (
    <>
      {showTerrain ? <TerrainSurface size={terrainSize} /> : null}
      {showSatelliteImage && texture && contextBounds ? (
        <mesh position={[contextBounds.x, 0.04, contextBounds.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[contextBounds.width, contextBounds.depth]} />
          <meshBasicMaterial map={texture} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
      {showSatelliteImage && texture ? (
        <mesh geometry={shapeGeometry} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
          <meshBasicMaterial map={texture} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
      {showSatelliteImage && processedImagery ? (
        <ProcessedFarmSurface
          coordinates={coordinates}
          center={center}
          imagery={processedImagery}
          onStateChange={onProcessedImageryStateChange}
        />
      ) : null}
      {showCropPrototype ? <CropPrototypeLibrary size={terrainSize} /> : null}
      {showSatelliteImage || showPlots || showInfrastructure ? (
        <Line points={boundaryLine} color="#f4fff2" lineWidth={2} />
      ) : null}
      {landUseRegions.filter((region) => (
        region.kind === 'plot' ? showPlots : showInfrastructure
      )).map((region) => (
        <LandUseRegionSurface key={region.id} region={region} center={center} />
      ))}
    </>
  );
}

export default function FarmDigitalTwin(props: FarmDigitalTwinProps) {
  return <FarmImagerySurface {...props} />;
}
