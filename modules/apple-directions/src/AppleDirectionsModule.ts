import { NativeModule, requireOptionalNativeModule } from 'expo';

export type AppleRoute = {
  routeSeconds: number;
  distanceMeters: number;
  name: string;
  advisoryNotices: string[];
  coordinates: { latitude: number; longitude: number }[];
};

export type AppleRoutesResponse = {
  // Traffic-aware estimate for the primary (first) route.
  etaSeconds?: number;
  routes: AppleRoute[];
};

declare class AppleDirectionsModule extends NativeModule<{}> {
  getRoutes(
    fromLat: number,
    fromLon: number,
    toLat: number,
    toLon: number
  ): Promise<AppleRoutesResponse>;
}

// null in Expo Go, where the native module is not compiled in.
export default requireOptionalNativeModule<AppleDirectionsModule>('AppleDirections');
