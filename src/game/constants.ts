export const LANE_WIDTH = 3.8;
export const LANES_PER_DIR = 2;
export const ROAD_HALF = (LANE_WIDTH * LANES_PER_DIR * 2) / 2;
export const ROAD_WIDTH = LANE_WIDTH * LANES_PER_DIR * 2;
/** Average block size (legacy threshold helper); real city uses irregular gaps */
export const BLOCK = 100;
export const CITY_BLOCKS = 6;
/** How far stop lines / signal poles sit outside the junction box */
export const LIGHT_SETBACK = 10;
/** Traffic signal timings (seconds) */
/** Equal green on every axis at junctions the player is NOT approaching */
export const LIGHT_GREEN_NORMAL = 12;
/** Player road at the junction we are on */
export const LIGHT_GREEN = 18;
/** Cross-street at the player junction only (player red ≤ LIGHT_RED) */
export const LIGHT_GREEN_CROSS = 6;
/** Amber: solid legally, lamp blinks on/off like a real Indian signal */
export const LIGHT_YELLOW = 4;
/** No all-red gap: red on our road is exactly cross green + cross yellow */
export const LIGHT_ALL_RED = 0;
/** Player-facing red is capped at this (cross green + yellow) */
export const LIGHT_RED = 10;
export const MAX_SPEED = 32; // m/s ~ 115 km/h in 5th
export const BRAKE = 18;
export const HANDBRAKE = 28;
/** Gentle rolling resistance when coasting (no gas / no brake) — real-car feel */
export const ROLLING_RESIST = 1.15;
export const STEER_SPEED = 3.2;
export const MAX_STEER = 0.62;
/** Unlimited fuel: the tank never drains (fuel HUD removed) */
export const FUEL_DRAIN = 0;
export const TRAFFIC_COUNT = 88;
/** Minimum gap between AI cars in the same lane at spawn (meters) */
export const TRAFFIC_MIN_GAP = 16;
/** No other vehicles inside this radius of the parking bay */
export const PARKING_KEEP_OUT_M = 10;
/** Pedestrians in the city (doubled) */
export const PED_COUNT = 96;

export const CAR_COLORS = [
  0xc62828,
  0x1565c0,
  0xf9a825,
  0x2e7d32,
  0x6a1b9a,
  0xeceff1,
  0xef6c00,
  0x00838f,
  0x37474f,
  0x5d4037,
];

export const PLAYER_COLOR = 0xb71c1c;

/** Zebra crossing: starts just outside the junction box and runs away from it */
export const ZEBRA_START = ROAD_WIDTH / 2 + 0.9;
export const ZEBRA_BARS = 6;
export const ZEBRA_BAR = 0.55;
export const ZEBRA_GAP = 0.4;
export const ZEBRA_LENGTH = ZEBRA_BARS * (ZEBRA_BAR + ZEBRA_GAP) - ZEBRA_GAP;
/** Stop line sits BEHIND the zebra (India): vehicles must never stop on the crossing */
export const STOP_LINE_SETBACK = ZEBRA_START + ZEBRA_LENGTH + 1.4;

/** Manual gearbox: accel (m/s²) and top speed (m/s) per gear */
export const GEAR_STATS: Record<
  string,
  { accel: number; maxSpeed: number; label: string }
> = {
  P: { accel: 0, maxSpeed: 0, label: "P" },
  R: { accel: 7, maxSpeed: 8, label: "R" },
  N: { accel: 0, maxSpeed: 0, label: "N" },
  "1": { accel: 14, maxSpeed: 9, label: "1" },
  "2": { accel: 11, maxSpeed: 15, label: "2" },
  "3": { accel: 8.5, maxSpeed: 22, label: "3" },
  "4": { accel: 6.5, maxSpeed: 28, label: "4" },
  "5": { accel: 4.5, maxSpeed: 32, label: "5" },
};

export const GEAR_ORDER = ["P", "R", "N", "1", "2", "3", "4", "5"] as const;
