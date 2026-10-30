// Butcher tableaus of the explicit Runge-Kutta solvers.

import type { SolverName } from './types';

export interface Tableau {
  c: number[];
  a: number[][];
  b: number[];
  /** b - b̂ of the embedded lower-order method (variable-step only). */
  e?: number[];
  /** Order used for step-size control (the lower order of an embedded pair). */
  order: number;
}

const dpA = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
const dpB = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
const dpBhat = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];

const bsA = [[], [1 / 2], [0, 3 / 4], [2 / 9, 1 / 3, 4 / 9]];
const bsB = [2 / 9, 1 / 3, 4 / 9, 0];
const bsBhat = [7 / 24, 1 / 4, 1 / 3, 1 / 8];

export const TABLEAUS: Record<SolverName, Tableau> = {
  // Dormand-Prince 5(4)
  ode45: { c: [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1], a: dpA, b: dpB, e: dpB.map((v, i) => v - dpBhat[i]), order: 4 },
  // Bogacki-Shampine 3(2)
  ode23: { c: [0, 1 / 2, 3 / 4, 1], a: bsA, b: bsB, e: bsB.map((v, i) => v - bsBhat[i]), order: 2 },
  // Euler
  ode1: { c: [0], a: [[]], b: [1], order: 1 },
  // Heun
  ode2: { c: [0, 1], a: [[], [1]], b: [1 / 2, 1 / 2], order: 2 },
  // Bogacki-Shampine 3rd order
  ode3: { c: [0, 1 / 2, 3 / 4], a: [[], [1 / 2], [0, 3 / 4]], b: [2 / 9, 1 / 3, 4 / 9], order: 3 },
  // Classic Runge-Kutta
  ode4: { c: [0, 1 / 2, 1 / 2, 1], a: [[], [1 / 2], [0, 1 / 2], [0, 0, 1]], b: [1 / 6, 1 / 3, 1 / 3, 1 / 6], order: 4 },
  // Dormand-Prince 5th order without the error stage
  ode5: { c: [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1], a: dpA.slice(0, 6), b: dpB.slice(0, 6), order: 5 },
};

export const SOLVER_LABELS: Record<SolverName, string> = {
  ode45: 'ode45 (Dormand-Prince, premenlivý krok)',
  ode23: 'ode23 (Bogacki-Shampine, premenlivý krok)',
  ode1: 'ode1 (Euler, pevný krok)',
  ode2: 'ode2 (Heun, pevný krok)',
  ode3: 'ode3 (Bogacki-Shampine, pevný krok)',
  ode4: 'ode4 (Runge-Kutta, pevný krok)',
  ode5: 'ode5 (Dormand-Prince, pevný krok)',
};
