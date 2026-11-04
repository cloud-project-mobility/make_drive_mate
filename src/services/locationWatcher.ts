import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { createBrowserLocationHub } from './browserLocation';

const browserLocation = createBrowserLocationHub();

export async function watchForegroundPosition(
  onPosition: (location: Location.LocationObject) => void,
  onError: (reason: string) => void,
): Promise<Location.LocationSubscription> {
  if (Platform.OS !== 'web') {
    return Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 1_000, distanceInterval: 3 },
      onPosition,
      onError,
    );
  }
  if (typeof navigator === 'undefined' || !navigator.geolocation)
    throw new Error('Geolocation is unavailable');
  if (typeof window !== 'undefined' && window.isSecureContext === false)
    throw new Error('insecure_context');
  // Expo 57's web adapter drops the browser error callback and assumes its subscription ID
  // equals the browser's watch ID. Own the browser watch so errors and cleanup are exact.
  return browserLocation.subscribe(
    navigator.geolocation,
    (position) =>
      onPosition({
        timestamp: position.timestamp,
        coords: {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: position.coords.altitude,
          altitudeAccuracy: position.coords.altitudeAccuracy,
          heading: position.coords.heading,
          speed: position.coords.speed,
        },
      }),
    onError,
  );
}
