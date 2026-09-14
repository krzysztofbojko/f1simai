import { Vector2 } from '../math/Vector2';
import { Spline } from '../math/Spline';
import { Track } from './Track';

export class Presets {
  static readonly GRAND_PRIX_POINTS: Vector2[] = [
    new Vector2(250, 700), // Main straight start
    new Vector2(600, 700), // Main straight mid
    new Vector2(950, 700), // Turn 1 braking zone
    new Vector2(1080, 620), // Turn 1 entry
    new Vector2(1050, 480), // Chicane switch
    new Vector2(1100, 360), // Chicane exit
    new Vector2(1050, 200), // Curve towards back straight
    new Vector2(850, 140),  // High speed sweeper
    new Vector2(600, 160),  // Back straight
    new Vector2(350, 140),  // Hairpin approach
    new Vector2(160, 200),  // Hairpin apex
    new Vector2(140, 350),  // Hairpin exit
    new Vector2(240, 440),  // Technical S-curve 1
    new Vector2(150, 560),  // Technical S-curve 2
  ];

  static readonly OVAL_POINTS: Vector2[] = [
    new Vector2(300, 650),
    new Vector2(850, 650),
    new Vector2(1050, 500),
    new Vector2(1050, 300),
    new Vector2(850, 150),
    new Vector2(300, 150),
    new Vector2(120, 300),
    new Vector2(120, 500),
  ];

  static createGrandPrixTrack(width: number = 90): Track {
    const splinePoints = Spline.generateClosedTrack(Presets.GRAND_PRIX_POINTS, width, 18);
    return new Track(splinePoints, width);
  }

  static createOvalTrack(width: number = 100): Track {
    const splinePoints = Spline.generateClosedTrack(Presets.OVAL_POINTS, width, 20);
    return new Track(splinePoints, width);
  }
}
