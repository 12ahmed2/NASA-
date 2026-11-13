import type { GeoPoint } from './FarmMap';

export interface CropRecommendationRequest {
  location: GeoPoint & { formattedAddress: string };
  areaSquareMeters: number;
  plots: Array<{ id: string; name: string; areaSquareMeters: number }>;
}

export interface CropRecommendation {
  cropId: string;
  cropName: string;
  explanation: string;
}

export interface CropRecommendationProvider {
  getRecommendations(request: CropRecommendationRequest): Promise<CropRecommendation[]>;
}

export interface CropRecommendationResult {
  status: 'placeholder' | 'ready';
  recommendations: CropRecommendation[];
  message: string;
}

export const getCropRecommendations = (
  _request: CropRecommendationRequest,
): CropRecommendationResult => ({
  status: 'placeholder',
  recommendations: [],
  message: 'Crop recommendations are not available yet. Connect an agricultural data provider to show data-based suggestions.',
});
