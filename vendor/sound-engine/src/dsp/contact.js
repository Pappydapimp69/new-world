/**
 * Hertz impact contact. Contact time tc = 2.87 (m^2 / (R E*^2 v))^(1/5)
 * (checked against an RK4 integration of m x'' = -k x^1.5 to 0.999).
 * With a soft fleshy pad, E* is set by the pad: packed dirt and sandstone
 * differ by 2.6% in tc, only claws (5.1x) or mud (1.55x) change it
 * (dlist/E17). Surface identity therefore comes from the surface response.
 */
export function effectiveModulus(e1, e2, nu1 = 0.4, nu2 = 0.4) {
  return 1 / ((1 - nu1 * nu1) / e1 + (1 - nu2 * nu2) / e2);
}

/**
 * @param {number} mass effective impacting mass (kg)
 * @param {number} speed impact speed (m/s)
 * @param {number} radius contact radius of curvature (m)
 * @param {number} estar effective modulus (Pa)
 * @returns {number} contact duration (s)
 */
export function hertzContactTime(mass, speed, radius, estar) {
  return 2.87 * ((mass * mass) / (radius * estar * estar * Math.max(speed, 1e-3))) ** 0.2;
}

/** Moduli (Pa) used by the footstep presets; game estimates. */
export const MODULI = {
  pad: 2e6,
  claw: 2e9,
  mud: 1e6,
  packedDirt: 30e6,
  sand: 15e6,
  wood: 1e9,
  sandstone: 15e9,
  water: 2e6,
};
