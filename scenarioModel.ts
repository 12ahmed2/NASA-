export type ScenarioCrop = 'wheat' | 'corn' | 'rice' | 'tomato' | 'potato' | 'cotton' | 'other';

export interface FarmScenario {
  id: string;
  name: string;
  plotId: string;
  plotName: string;
  plotAreaSquareMeters: number;
  crop: ScenarioCrop;
  plantingDate: string;
  soilDescription: string;
  plannedIrrigationVolumeM3: number | null;
  seasonalEtcMm: number | null;
  effectiveRainfallMm: number | null;
  applicationEfficiencyPercent: number | null;
  inputSource: string;
  createdAt: string;
}

export interface WaterBalance {
  netIrrigationRequirementMm: number;
  effectiveIrrigationMm: number;
  irrigationBalanceMm: number;
  deficitMm: number;
  requiredGrossIrrigationVolumeM3: number;
}

const isNonNegativeFinite = (value: number | null): value is number => (
  value !== null && Number.isFinite(value) && value >= 0
);

export const calculateWaterBalance = (scenario: FarmScenario): WaterBalance | null => {
  const {
    plotAreaSquareMeters,
    plannedIrrigationVolumeM3,
    seasonalEtcMm,
    effectiveRainfallMm,
    applicationEfficiencyPercent,
  } = scenario;

  if (!Number.isFinite(plotAreaSquareMeters) || plotAreaSquareMeters <= 0
    || !isNonNegativeFinite(plannedIrrigationVolumeM3)
    || !isNonNegativeFinite(seasonalEtcMm)
    || !isNonNegativeFinite(effectiveRainfallMm)
    || applicationEfficiencyPercent === null
    || !Number.isFinite(applicationEfficiencyPercent)
    || applicationEfficiencyPercent <= 0
    || applicationEfficiencyPercent > 100) {
    return null;
  }

  const netIrrigationRequirementMm = Math.max(0, seasonalEtcMm - effectiveRainfallMm);
  const grossIrrigationDepthMm = (plannedIrrigationVolumeM3 * 1000) / plotAreaSquareMeters;
  const effectiveIrrigationMm = grossIrrigationDepthMm * (applicationEfficiencyPercent / 100);
  const irrigationBalanceMm = effectiveIrrigationMm - netIrrigationRequirementMm;
  const requiredGrossIrrigationVolumeM3 = (
    (netIrrigationRequirementMm * plotAreaSquareMeters) / 1000
  ) / (applicationEfficiencyPercent / 100);

  return {
    netIrrigationRequirementMm,
    effectiveIrrigationMm,
    irrigationBalanceMm,
    deficitMm: Math.max(0, -irrigationBalanceMm),
    requiredGrossIrrigationVolumeM3,
  };
};
