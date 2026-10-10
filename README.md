# Paradigm Mobile

**A movement operating system for real-world participation, place interaction, and progression.**

Paradigm treats the relationship between a person and a physical place as something that can persist.

Rather than reducing movement to steps, distance, or calories, Paradigm models movement sessions, node-level history, behavioral signals, and progression over time.

This repository contains the mobile prototype and the progression/economic simulation work through Stage 6.

## Product Model

Paradigm is organized around a few connected ideas:

- **Movement:** physical activity is the foundational input.
- **Nodes:** real-world places can accumulate interaction history.
- **XP:** progression represents accumulated movement and participation.
- **Memory:** completed activity persists instead of disappearing after a session.
- **Behavior:** repeated patterns can produce higher-level signals over time.

Walking is a foundational movement layer, not the entirety of the product.

The core loop is:

**move → interact with place → complete activity → update persistent state → build history**

## Current Prototype

The mobile prototype has progressed through Checkpoint 6.5.

| Checkpoint | Implementation |
|---|---|
| 1 | Living world foundation |
| 2 | Interactive node panels |
| 4 | Persistent memory |
| 5 | Behavioral signals |
| 6.1 | Simulation foundation |
| 6.2 | Economic stress tests |
| 6.3 | Deterministic population economy |
| 6.4 | Economic sensitivity lab |
| 6.5 | Candidate economy and Stage 6 closeout |

These are development checkpoints, not separate user-facing product releases.

Earlier checkpoint functionality is often integrated into the primary application and supporting modules rather than represented by one file per stage.

## Movement and Progression

The prototype currently explores:

- Movement sessions and completion
- Place and node interaction
- Walking as a foundational activity layer
- XP attribution and progression
- Behavioral signals
- Persistence of activity history

The aim is to build a coherent relationship between physical participation and persistent progression rather than reward movement indiscriminately.

## Stage 6: Economic Simulation

Stage 6 introduced a deterministic testing environment for the XP economy.

Instead of selecting progression values entirely by intuition, the system can compare candidate economies under simulated behavioral conditions.

The work includes:

- Simulation of different participation patterns
- Economic stress testing
- Deterministic population modeling
- Sensitivity analysis
- Candidate economy evaluation
- Checks for grinding, stagnation, inflation, walking dominance, and reward concentration

Checkpoint 6.5 concluded this phase with a selected candidate economy and a known quantified tradeoff.

These are internal simulation results, not evidence of real-world user adoption or retention.

## Technical Foundation

The repository uses:

- TypeScript
- React Native
- Expo
- AsyncStorage for local persistence
- Development-stage simulation and validation modules

Development has progressed incrementally through identifiable checkpoints preserved in the repository history.

## Running Locally

Install dependencies:

```bash
npm install
```

Start the Expo development environment:

```bash
npx expo start
```

Check TypeScript:

```bash
npx tsc --noEmit
```

## Repository Structure

Key files currently include:

- `App.tsx` — mobile application implementation
- `behavioralSignals.ts` — behavioral signal logic
- `stage6Simulation.ts` — simulation foundation
- `stage6StressTests.ts` — economic stress testing
- `stage6PopulationSimulation.ts` — deterministic population simulation
- `stage6SensitivityLab.ts` — sensitivity analysis
- `stage6CandidateEconomy.ts` — candidate economy evaluation

The commit history documents the progression through earlier development checkpoints.

## Related Repository

### Paradigm Engine

https://github.com/1990DON/paradigm-engine

`paradigm-engine` contains the earlier behavioral/event-processing architecture, movement and place-memory concepts, proof lanes, and supporting system design.

`paradigm-mobile` contains the mobile application prototype and the subsequent progression and economic simulation work.

## Development Status

**Stage 6 is closed through Checkpoint 6.5.**

**Stage 7: backend structure.**

The next architectural phase is defining the client/backend ownership boundary, persistent entities, API boundaries, and authoritative state needed to move Paradigm beyond a purely local prototype.

Paradigm remains an independently developed prototype. Real-world product validation and broader user adoption are still ahead.
