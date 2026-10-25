
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Image,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, Polygon, PROVIDER_GOOGLE } from 'react-native-maps';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import * as SplashScreen from 'expo-splash-screen';
import { supabase } from './supabase';

if (Platform.OS !== 'web') {
  void SplashScreen.preventAutoHideAsync();
}

type Screen = 'home' | 'search' | 'signup' | 'login' | 'ride' | 'myrides' | 'account' | 'driver' | 'selfie' | 'review' | 'driver-review';
const GOOGLE_MAPS_IOS_ENABLED = process.env.EXPO_PUBLIC_GOOGLE_MAPS_IOS_ENABLED === 'true';
const GOOGLE_MAP_PROVIDER = Platform.OS === 'android' || (
  Platform.OS === 'ios' &&
  GOOGLE_MAPS_IOS_ENABLED
) ? PROVIDER_GOOGLE : undefined;
type NavigationTab = 'home' | 'rides' | 'account';
type Point = { latitude: number; longitude: number };
type RideOptionId = 'wait_save' | 'comfort' | 'xl';
type RideOption = {
  id: RideOptionId;
  title: string;
  detail: string;
  multiplier: number;
  maxPassengers: number;
};

const RIDE_OPTIONS: RideOption[] = [
  { id: 'wait_save', title: 'Wait & Save', detail: 'Lowest estimate', multiplier: 1, maxPassengers: 4 },
  { id: 'comfort', title: 'Comfort', detail: 'More space', multiplier: 1.2, maxPassengers: 4 },
  { id: 'xl', title: 'XL', detail: 'Larger group', multiplier: 1.5, maxPassengers: 6 },
];
type LocationSuggestion = { label: string; point: Point };

type Ride = {
  id: string;
  pickup_address: string;
  destination_address: string;
  payment_method: string;
  status: string;
  created_at: string;
  dispatch_status?: string;
  ride_type?: RideOptionId;
  passenger_count?: number;
  estimated_fare?: number;
  driver_name?: string | null;
  driver_phone?: string | null;
  driver_vehicle?: string | null;
};

const isDriverDispatchSchemaMissing = (error: { code?: string; message?: string } | null) =>
  error?.code === 'PGRST202' || error?.code === 'PGRST204' || error?.code === '42703';

type DriverProfile = {
  driver_id: string;
  full_name: string;
  phone: string;
  vehicle_make: string;
  vehicle_model: string;
  vehicle_color: string;
  vehicle_registration: string;
  max_passengers: number;
  ride_types: RideOptionId[];
  application_status: 'pending' | 'approved' | 'rejected';
  subscription_status: 'inactive' | 'active';
  subscription_renews_at: string | null;
  is_available: boolean;
};

type SelfieVerification = {
  passenger_id: string;
  selfie_path: string;
  status: 'pending' | 'approved' | 'rejected';
  submitted_at: string;
  reviewed_at: string | null;
};

type SelfieReviewItem = SelfieVerification & { signed_url: string };

const selfieBase64ToBytes = (base64: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4) - padding);
  let accumulator = 0;
  let bitCount = 0;
  let offset = 0;

  for (const character of clean) {
    if (character === '=') break;
    const value = alphabet.indexOf(character);
    if (value < 0) continue;
    accumulator = (accumulator << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[offset++] = (accumulator >> bitCount) & 255;
    }
  }

  return bytes.subarray(0, offset);
};

const getProfilePhotoUrl = async (path: string | null | undefined) => {
  if (!path) return '';
  const { data, error } = await supabase.storage.from('profile-pictures').createSignedUrl(path, 60 * 60 * 24);
  if (error) throw error;
  return data.signedUrl;
};

const DEFAULT_CAMERA = { center: { latitude: -26.2041, longitude: 28.0473 }, zoom: 10, heading: 0, pitch: 0 };
const pointAtBearing = (origin: Point, bearingDegrees: number, distanceMeters: number): Point => {
  const bearing = bearingDegrees * (Math.PI / 180);
  const latitudeRadians = origin.latitude * (Math.PI / 180);
  return {
    latitude: origin.latitude + (distanceMeters * Math.cos(bearing)) / 111320,
    longitude: origin.longitude + (distanceMeters * Math.sin(bearing)) / (111320 * Math.cos(latitudeRadians)),
  };
};

const FARE_BASE_ZAR = 5;
const FARE_PER_KM_ZAR = 5;
const ESTIMATED_ROUTE_FACTOR = 1.25;
const FARE_ROUNDING_ZAR = 5;

const calculateFareEstimate = (pickupPoint: Point | null, destinationPoint: Point | null) => {
  if (!pickupPoint || !destinationPoint) return null;

  const toRadians = (degrees: number) => degrees * (Math.PI / 180);
  const latitudeDifference = toRadians(destinationPoint.latitude - pickupPoint.latitude);
  const longitudeDifference = toRadians(destinationPoint.longitude - pickupPoint.longitude);
  const pickupLatitude = toRadians(pickupPoint.latitude);
  const destinationLatitude = toRadians(destinationPoint.latitude);
  const haversine =
    Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(pickupLatitude) * Math.cos(destinationLatitude) *
    Math.sin(longitudeDifference / 2) ** 2;
  const directDistanceKm = 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  const estimatedRouteKm = directDistanceKm * ESTIMATED_ROUTE_FACTOR;
  const rawFare = FARE_BASE_ZAR + estimatedRouteKm * FARE_PER_KM_ZAR;
  const fareZar = Math.ceil(rawFare / FARE_ROUNDING_ZAR) * FARE_ROUNDING_ZAR;

  return { distanceKm: estimatedRouteKm, fareZar };
};

const calculateOptionFare = (baseFare: number | null, option: RideOption) => {
  if (baseFare === null) return null;
  return Math.ceil((baseFare * option.multiplier) / FARE_ROUNDING_ZAR) * FARE_ROUNDING_ZAR;
};

const PickupPinIcon = () => (
  <View style={styles.pickupPinIcon}>
    <View style={styles.pickupPinTail} />
    <View style={styles.pickupPinHead}>
      <View style={styles.pickupPinCore} />
    </View>
  </View>
);

const MapPickupMarker = () => (
  <View style={styles.mapPickupMarker}>
    <View style={styles.mapPickupMarkerHead}><View style={styles.mapPickupMarkerCore} /></View>
    <View style={styles.mapPickupMarkerTail} />
  </View>
);

const LocationTargetIcon = () => (
  <View style={styles.locationTargetOuter}>
    <View style={styles.locationTargetInner} />
  </View>
);

const SearchIcon = () => (
  <View style={styles.searchIconWrap}>
    <View style={styles.searchIconLens} />
    <View style={styles.searchIconHandle} />
  </View>
);

const MenuIcon = () => (
  <View style={styles.menuIcon}>
    <View style={styles.menuIconLine} />
    <View style={styles.menuIconLine} />
    <View style={styles.menuIconLine} />
  </View>
);

const BottomNavIcon = ({ tab, active }: { tab: NavigationTab; active: boolean }) => {
  const color = active ? '#171A21' : '#7B8491';

  if (tab === 'home') {
    return (
      <View style={styles.navHouse}>
        <View style={[styles.navHouseRoofLeft, { backgroundColor: color }]} />
        <View style={[styles.navHouseRoofRight, { backgroundColor: color }]} />
        <View style={[styles.navHouseBody, active ? { backgroundColor: color } : { borderColor: color }]}>
          <View style={[styles.navHouseDoor, active ? { backgroundColor: '#FFFFFF' } : { borderColor: color }]} />
        </View>
      </View>
    );
  }

  if (tab === 'rides') {
    return (
      <View style={[styles.navCalendar, { borderColor: color }]}>
        <View style={[styles.navCalendarTop, { backgroundColor: color }]} />
        <View style={[styles.navCalendarRingLeft, { backgroundColor: color }]} />
        <View style={[styles.navCalendarRingRight, { backgroundColor: color }]} />
        <View style={[styles.navCalendarClock, { borderColor: color }]}>
          <View style={[styles.navCalendarClockHand, { backgroundColor: color }]} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.navProfile}>
      <View style={[styles.navProfileHead, { backgroundColor: color }]} />
      <View style={[styles.navProfileShoulders, active ? { backgroundColor: color } : { borderColor: color }]} />
    </View>
  );
};

const BottomNavigation = ({
  active,
  onHome,
  onRides,
  onAccount,
}: {
  active: NavigationTab;
  onHome: () => void;
  onRides: () => void;
  onAccount: () => void;
}) => {
  const items: { id: NavigationTab; label: string; onPress: () => void }[] = [
    { id: 'home', label: 'Home', onPress: onHome },
    { id: 'rides', label: 'Rides', onPress: onRides },
    { id: 'account', label: 'Account', onPress: onAccount },
  ];

  return (
    <View style={styles.bottomNavigation}>
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <TouchableOpacity
            key={item.id}
            style={styles.bottomNavigationItem}
            onPress={item.onPress}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={item.label}
          >
            <BottomNavIcon tab={item.id} active={isActive} />
            <Text style={[styles.bottomNavigationLabel, isActive && styles.bottomNavigationLabelActive]}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const PrimaryButton = ({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) => (
  <TouchableOpacity style={[styles.primaryButton, disabled && styles.disabledButton]} onPress={onPress} disabled={disabled} activeOpacity={0.8}>
    {disabled ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>{title}</Text>}
  </TouchableOpacity>
);

export default function App() {
  const mapRef = useRef<React.ElementRef<typeof MapView>>(null);
  const followLiveLocationRef = useRef(false);
  const phoneHeadingRef = useRef<number | null>(null);
  const [isAppReady, setIsAppReady] = useState(false);
  const [screen, setScreen] = useState<Screen>('home');
  const [menuOpen, setMenuOpen] = useState(false);


const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loggedInEmail, setLoggedInEmail] = useState('');
  const [profilePhotoUrl, setProfilePhotoUrl] = useState('');
  const [profilePhotoBusy, setProfilePhotoBusy] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selfieBusy, setSelfieBusy] = useState(false);
  const [reviewBusyId, setReviewBusyId] = useState('');
  const [reviewQueueBusy, setReviewQueueBusy] = useState(false);
  const [selfieVerification, setSelfieVerification] = useState<SelfieVerification | null>(null);
  const [selfiePreviewUri, setSelfiePreviewUri] = useState('');
  const [selfieReturnScreen, setSelfieReturnScreen] = useState<Screen>('ride');
  const [selfieReviewQueue, setSelfieReviewQueue] = useState<SelfieReviewItem[]>([]);
  const [locationBusy, setLocationBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [ridesBusy, setRidesBusy] = useState(false);
  const [driverBusy, setDriverBusy] = useState(false);
  const [driverProfile, setDriverProfile] = useState<DriverProfile | null>(null);
  const [driverSubscriptionCurrent, setDriverSubscriptionCurrent] = useState(false);
  const [driverQueue, setDriverQueue] = useState<Ride[]>([]);
  const [driverActiveRide, setDriverActiveRide] = useState<Ride | null>(null);
  const [driverReviewQueue, setDriverReviewQueue] = useState<DriverProfile[]>([]);
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [vehicleMake, setVehicleMake] = useState('');
  const [vehicleModel, setVehicleModel] = useState('');
  const [vehicleColor, setVehicleColor] = useState('');
  const [vehicleRegistration, setVehicleRegistration] = useState('');
  const [driverCapacity, setDriverCapacity] = useState('4');

  const [pickup, setPickup] = useState('');
  const [destination, setDestination] = useState('');
  const [pickupPoint, setPickupPoint] = useState<Point | null>(null);
  const [locationPermissionGranted, setLocationPermissionGranted] = useState(false);
  const [pickupIsCurrentLocation, setPickupIsCurrentLocation] = useState(false);
  const [deviceLocationPoint, setDeviceLocationPoint] = useState<Point | null>(null);
  const [phoneHeading, setPhoneHeading] = useState<number | null>(null);
  const [destinationPoint, setDestinationPoint] = useState<Point | null>(null);
  const [destinationFocused, setDestinationFocused] = useState(false);
  const [locationSuggestions, setLocationSuggestions] = useState<LocationSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsMessage, setSuggestionsMessage] = useState('');
  const geocodingPermissionAsked = useRef(false);
  const [selectedRideOptionId, setSelectedRideOptionId] = useState<RideOptionId>('wait_save');
  const [passengerCount, setPassengerCount] = useState(1);
  const [mapTarget, setMapTarget] = useState<'pickup' | 'destination'>('pickup');
  const [rides, setRides] = useState<Ride[]>([]);
  const routeFareEstimate = calculateFareEstimate(pickupPoint, destinationPoint);
  const selectedRideOption = RIDE_OPTIONS.find((option) => option.id === selectedRideOptionId)!;
  const fareEstimate = calculateOptionFare(routeFareEstimate?.fareZar ?? null, selectedRideOption);
  const previewMapPoints = [pickupPoint, destinationPoint].filter((point): point is Point => point !== null);
  if (previewMapPoints.length === 0 && deviceLocationPoint) previewMapPoints.push(deviceLocationPoint);
  if (previewMapPoints.length === 0) previewMapPoints.push(DEFAULT_CAMERA.center);
  const previewSouth = Math.min(...previewMapPoints.map((point) => point.latitude));
  const previewNorth = Math.max(...previewMapPoints.map((point) => point.latitude));
  const previewWest = Math.min(...previewMapPoints.map((point) => point.longitude));
  const previewEast = Math.max(...previewMapPoints.map((point) => point.longitude));
  const previewLatitudePadding = previewNorth === previewSouth ? 0.018 : Math.max((previewNorth - previewSouth) * 0.2, 0.004);
  const previewLongitudePadding = previewWest === previewEast ? 0.024 : Math.max((previewEast - previewWest) * 0.2, 0.004);
  const previewMarker = pickupPoint ?? deviceLocationPoint ?? destinationPoint ?? DEFAULT_CAMERA.center;
  const previewMapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${previewWest - previewLongitudePadding}%2C${previewSouth - previewLatitudePadding}%2C${previewEast + previewLongitudePadding}%2C${previewNorth + previewLatitudePadding}&layer=mapnik&marker=${previewMarker.latitude}%2C${previewMarker.longitude}`;
  const headingConeCoordinates = deviceLocationPoint && phoneHeading !== null
    ? [
        deviceLocationPoint,
        pointAtBearing(deviceLocationPoint, phoneHeading - 18, 18),
        pointAtBearing(deviceLocationPoint, phoneHeading, 48),
        pointAtBearing(deviceLocationPoint, phoneHeading + 18, 18),
      ]
    : null;

  useEffect(() => {
    let isActive = true;
    supabase.auth.getSession()
      .then(({ data }) => {
        if (!isActive) return;
        const user = data.session?.user;
        setLoggedInEmail(user?.email ?? '');
        setIsAdmin(user?.app_metadata?.role === 'admin');
        void getProfilePhotoUrl(user?.user_metadata?.profile_photo_path)
          .then((url) => { if (isActive) setProfilePhotoUrl(url); })
          .catch(() => { if (isActive) setProfilePhotoUrl(''); });
      })
      .catch(() => undefined)
      .finally(() => {
        if (isActive) setIsAppReady(true);
      });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setLoggedInEmail(session?.user.email ?? '');
      setIsAdmin(session?.user.app_metadata?.role === 'admin');
      void getProfilePhotoUrl(session?.user.user_metadata?.profile_photo_path)
        .then(setProfilePhotoUrl)
        .catch(() => setProfilePhotoUrl(''));
    });

    return () => {
      isActive = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (screen !== 'account' || !loggedInEmail) return;
    let isCurrent = true;
    void supabase.auth.getUser().then(async ({ data, error }) => {
      if (error || !data.user) return '';
      return getProfilePhotoUrl(data.user.user_metadata?.profile_photo_path);
    }).then((url) => {
      if (isCurrent && url) setProfilePhotoUrl(url);
    }).catch(() => undefined);
    return () => { isCurrent = false; };
  }, [screen, loggedInEmail]);

  useEffect(() => {
    if (isAppReady && Platform.OS !== 'web') {
      SplashScreen.hide();
    }
  }, [isAppReady]);

  useEffect(() => {
    const query = destination.trim();
    let isCurrentRequest = true;

    if (!destinationFocused || query.length < 3) {
      const resetTimer = setTimeout(() => {
        if (!isCurrentRequest) return;
        setLocationSuggestions([]);
        setSuggestionsLoading(false);
        setSuggestionsMessage('');
      }, 0);
      return () => {
        isCurrentRequest = false;
        clearTimeout(resetTimer);
      };
    }

    const timer = setTimeout(async () => {
      setSuggestionsLoading(true);
      setSuggestionsMessage('');

      try {
        if (Platform.OS === 'android') {
          let permission = await Location.getForegroundPermissionsAsync();

          if (permission.status !== 'granted' && !geocodingPermissionAsked.current) {
            geocodingPermissionAsked.current = true;
            permission = await Location.requestForegroundPermissionsAsync();
          }

          if (permission.status !== 'granted') {
            if (isCurrentRequest) {
              setSuggestionsMessage('Location permission is needed for place search on Android.');
            }
            return;
          }
        }

        const results = await Location.geocodeAsync(query);
        const suggestions = await Promise.all(
          results.slice(0, 4).map(async (result) => {
            const point = { latitude: result.latitude, longitude: result.longitude };
            let label = '';

            try {
              const [place] = await Location.reverseGeocodeAsync(point);
              if (place) {
                const street = [place.streetNumber, place.street].filter(Boolean).join(' ');
                label = [...new Set([place.name, street, place.district, place.city, place.region].filter(Boolean))].join(', ');
              }
            } catch {
              // Use the search query when a place name is unavailable.
            }

            return {
              label: label || `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`,
              point,
            };
          })
        );

        if (isCurrentRequest) {
          const uniqueSuggestions = suggestions.filter(
            (suggestion, index, all) => all.findIndex((candidate) => candidate.label === suggestion.label) === index
          );
          setLocationSuggestions(uniqueSuggestions);
          if (uniqueSuggestions.length === 0) setSuggestionsMessage('No real places matched that search. Try a nearby street or suburb.');
        }
      } catch {
        if (isCurrentRequest) {
          setLocationSuggestions([]);
          setSuggestionsMessage('Live place search is unavailable right now. Try again or choose a point on the map.');
        }
      } finally {
        if (isCurrentRequest) setSuggestionsLoading(false);
      }
    }, 650);

    return () => {
      isCurrentRequest = false;
      clearTimeout(timer);
    };
  }, [destination, destinationFocused]);

  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidHide', () => {
      setDestinationFocused(false);
    });

    return () => subscription.remove();
  }, []);

  const notify = (title: string, message: string) => {
    Alert.alert(title, message);
  };

  const getAddress = async (point: Point) => {
    try {
      const results = await Location.reverseGeocodeAsync(point);
      const place = results[0];

      if (place) {
        const parts = [
          place.name,
          place.street,
          place.district,
          place.city,
        ].filter(Boolean);

        return [...new Set(parts)].join(', ') || 'Selected map location';
      }
    } catch {
      // Keep the coordinates as a fallback if address lookup fails.
    }

    return `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
  };

  const selectPoint = async (point: Point) => {
    const address = await getAddress(point);

    if (mapTarget === 'pickup') {
      setPickupPoint(point);
      setPickupIsCurrentLocation(false);
      setPickup(address);
    } else {
      setDestinationPoint(point);
      setDestination(address);
    }
  };

  const onMapPress = async (event: { nativeEvent: { coordinate: Point } }) => {
    followLiveLocationRef.current = false;
    await selectPoint(event.nativeEvent.coordinate);
  };

  const useMyLocation = async () => {
    setLocationBusy(true);

    try {
      const permission = await Location.requestForegroundPermissionsAsync();

      if (permission.status !== 'granted') {
        notify('Location permission needed', 'Allow location access to use your current position.');
        return;
      }
      setLocationPermissionGranted(true);

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
        mayShowUserSettingsDialog: true,
      });

      const point = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      };

      setDeviceLocationPoint(point);
      setPickupPoint(point);
      setPickupIsCurrentLocation(true);
      setPickup(await getAddress(point));
      followLiveLocationRef.current = true;

      mapRef.current?.animateCamera({ center: point, zoom: 16, heading: phoneHeadingRef.current ?? 0 });
    } catch {
      notify('Could not get location', 'Check that location services are enabled and try again.');
    } finally {
      setLocationBusy(false);
    }
  };

  useEffect(() => {
    let isActive = true;

    const centerOnCurrentLocation = async () => {
      try {
        let permission = await Location.getForegroundPermissionsAsync();
        if (permission.status !== 'granted') {
          permission = await Location.requestForegroundPermissionsAsync();
        }
        if (permission.status !== 'granted') return;

        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Highest,
          mayShowUserSettingsDialog: true,
        });
        if (!isActive) return;

        setDeviceLocationPoint({
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
        });
        followLiveLocationRef.current = true;
        setLocationPermissionGranted(true);
        mapRef.current?.animateCamera({
          center: {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
          },
          zoom: 16,
          heading: phoneHeadingRef.current ?? 0,
        });
      } catch {
        // The map remains usable at its default camera when a fresh fix is unavailable.
      }
    };

    void centerOnCurrentLocation();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!locationPermissionGranted || (screen !== 'home' && screen !== 'ride')) return;

    let isActive = true;
    let headingSubscription: { remove: () => void } | undefined;
    let positionSubscription: { remove: () => void } | undefined;

    void Location.watchHeadingAsync((heading) => {
      if (!isActive || heading.accuracy === 0) return;
      const degrees = heading.trueHeading >= 0 ? heading.trueHeading : heading.magHeading;
      phoneHeadingRef.current = degrees;
      setPhoneHeading(degrees);
    }).then((subscription) => {
      if (isActive) headingSubscription = subscription;
      else subscription.remove();
    }).catch(() => {
      if (isActive) setPhoneHeading(null);
    });

    void Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 3, timeInterval: 1000 },
      (location) => {
        if (!isActive) return;
        const point = {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
        };
        setDeviceLocationPoint(point);
        if (followLiveLocationRef.current) {
          mapRef.current?.animateCamera({
            center: point,
            zoom: 16,
            heading: phoneHeadingRef.current ?? 0,
          });
        }
      }
    ).then((subscription) => {
      if (isActive) positionSubscription = subscription;
      else subscription.remove();
    }).catch(() => undefined);

    return () => {
      isActive = false;
      headingSubscription?.remove();
      positionSubscription?.remove();
    };
  }, [locationPermissionGranted, screen]);

  const handleDestinationChange = (value: string) => {
    setDestination(value);
    setDestinationPoint(null);
    setLocationSuggestions([]);
    setSuggestionsMessage('');
  };

  const chooseLocationSuggestion = (suggestion: LocationSuggestion, navigateToRide = false) => {
    setDestination(suggestion.label);
    setDestinationPoint(suggestion.point ?? null);
    setLocationSuggestions([]);
    setSuggestionsMessage('');
    setDestinationFocused(false);
    Keyboard.dismiss();
    if (suggestion.point) {
      mapRef.current?.animateCamera({ center: suggestion.point, zoom: 15 });
      if (navigateToRide) setScreen('ride');
    }
  };

  const chooseRideOption = (option: RideOption) => {
    setSelectedRideOptionId(option.id);
    setPassengerCount((currentCount) => Math.min(currentCount, option.maxPassengers));
  };

  const searchDestination = async (queryOverride?: string, navigateToRide = false) => {
    const query = (queryOverride ?? destination).trim();
    if (!query) {
      notify('Enter a destination', 'Type the place you want to travel to first.');
      return;
    }

    setSearchBusy(true);

    try {
      const results = await Location.geocodeAsync(query);

      if (!results.length) {
        notify('Place not found', 'Try a more specific address or tap the destination directly on the map.');
        return;
      }

      const point = {
        latitude: results[0].latitude,
        longitude: results[0].longitude,
      };

      setDestinationPoint(point);
      if (queryOverride) setDestination(queryOverride);
      setLocationSuggestions([]);
      setSuggestionsMessage('');
      setDestinationFocused(false);
      Keyboard.dismiss();

      mapRef.current?.animateCamera({ center: point, zoom: 15 });
      if (navigateToRide) setScreen('ride');
    } catch {
      notify('Search failed', 'Try again or select your destination by tapping the map.');
    } finally {
      setSearchBusy(false);
    }
  };

  const signUp = async () => {
    if (!email.trim() || !password) {
      notify('Missing details', 'Enter your email and password.');
      return;
    }

    if (password.length < 6) {
      notify('Password too short', 'Use at least 6 characters.');
      return;
    }

    setBusy(true);

    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });

      if (error) throw error;

      if (data.session) {
        setLoggedInEmail(data.session.user.email ?? email.trim());
        setIsAdmin(data.session.user.app_metadata?.role === 'admin');
        setSelfieVerification(null);
        setSelfiePreviewUri('');
        setScreen('home');
        notify('Welcome', 'Your account has been created.');
      } else {
        notify('Check your email', 'Confirm your email if requested, then log in.');
        setScreen('login');
      }
    } catch (error: any) {
      notify('Sign-up failed', error.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const logIn = async () => {
    if (!email.trim() || !password) {
      notify('Missing details', 'Enter your email and password.');
      return;
    }

    setBusy(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) throw error;

      setLoggedInEmail(data.user.email ?? email.trim());
      setIsAdmin(data.user.app_metadata?.role === 'admin');
      setScreen('home');
    } catch (error: any) {
      notify('Login failed', error.message ?? 'Check your details and try again.');
    } finally {
      setBusy(false);
    }
  };

  const logOut = async () => {
    const { error } = await supabase.auth.signOut();

    if (error) {
      notify('Could not log out', error.message);
      return;
    }

    setLoggedInEmail('');
    setProfilePhotoUrl('');
    setIsAdmin(false);
    setSelfieVerification(null);
    setSelfiePreviewUri('');
    setScreen('home');
  };

  const chooseProfilePhoto = async () => {
    if (!loggedInEmail) {
      notify('Log in first', 'Sign in to add a profile photo to your account.');
      setScreen('login');
      return;
    }

    setProfilePhotoBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
        base64: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.base64) throw new Error('The selected image could not be read. Please choose another photo.');
      const imageBytes = selfieBase64ToBytes(asset.base64);
      if (imageBytes.byteLength > 5 * 1024 * 1024) throw new Error('Choose a photo smaller than 5 MB.');

      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError || !authData.user) throw new Error('Your session expired. Log in again and retry.');
      const photoPath = `${authData.user.id}/avatar.jpg`;
      const { error: uploadError } = await supabase.storage
        .from('profile-pictures')
        .upload(photoPath, imageBytes, { contentType: 'image/jpeg', cacheControl: '0', upsert: true });
      if (uploadError) throw uploadError;

      const { error: profileError } = await supabase.auth.updateUser({ data: { profile_photo_path: photoPath } });
      if (profileError) throw profileError;
      setProfilePhotoUrl(await getProfilePhotoUrl(photoPath));
      notify('Profile photo updated', 'Your chosen photo is now saved to your LUMO account.');
    } catch (error: any) {
      const detail = error.message ?? 'Please try again.';
      notify('Could not save profile photo', detail.includes('profile-pictures') || detail.includes('Bucket not found')
        ? 'Profile photo storage is not set up yet. Apply the profile pictures migration, then try again.'
        : detail);
    } finally {
      setProfilePhotoBusy(false);
    }
  };

  const removeProfilePhoto = async () => {
    setProfilePhotoBusy(true);
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) throw new Error('Log in again to manage your profile photo.');
      const photoPath = data.user.user_metadata?.profile_photo_path as string | undefined;
      const { error: updateError } = await supabase.auth.updateUser({ data: { profile_photo_path: null } });
      if (updateError) throw updateError;
      setProfilePhotoUrl('');
      if (photoPath) {
        const { error: removeError } = await supabase.storage.from('profile-pictures').remove([photoPath]);
        if (removeError) {
          notify('Photo removed from your account', 'The profile photo is no longer shown. Its stored file could not be deleted.');
          return;
        }
      }
      notify('Profile photo removed', 'Your account is using its default profile image.');
    } catch (error: any) {
      notify('Could not remove profile photo', error.message ?? 'Please try again.');
    } finally {
      setProfilePhotoBusy(false);
    }
  };

  const loadPassengerSelfieVerification = async (passengerId: string) => {
    const { data, error } = await supabase
      .from('passenger_selfie_verifications')
      .select('passenger_id, selfie_path, status, submitted_at, reviewed_at')
      .eq('passenger_id', passengerId)
      .maybeSingle();
    if (error) throw error;
    const record = data as SelfieVerification | null;
    setSelfieVerification(record);
    return record;
  };

  const openPassengerSelfie = async (returnScreen: Screen) => {
    if (!loggedInEmail) {
      setScreen('login');
      return;
    }
    setSelfieReturnScreen(returnScreen);
    setScreen('selfie');
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) throw new Error('Log in again to check selfie verification.');
      await loadPassengerSelfieVerification(data.user.id);
    } catch (error: any) {
      notify('Selfie verification unavailable', error.message ?? 'Apply the passenger selfie setup migration, then try again.');
    }
  };

  const captureAndSubmitSelfie = async () => {
    setSelfieBusy(true);
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) throw new Error('Your session has expired. Log in again.');

      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) throw new Error('Camera access is needed to capture your verification selfie.');

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        cameraType: ImagePicker.CameraType.front,
        allowsEditing: false,
        quality: 0.7,
        base64: true,
        exif: false,
      });
      if (result.canceled) return;

      const asset = result.assets[0];
      if (!asset.base64) throw new Error('The camera did not return an image. Please retake your selfie.');
      const imageBytes = selfieBase64ToBytes(asset.base64);
      if (imageBytes.byteLength === 0 || imageBytes.byteLength > 5 * 1024 * 1024) {
        throw new Error('The selfie must be smaller than 5 MB. Retake it in good light.');
      }

      setSelfiePreviewUri(asset.uri);
      const selfiePath = `${userData.user.id}/selfie.jpg`;
      const { error: uploadError } = await supabase.storage
        .from('passenger-selfies')
        .upload(selfiePath, imageBytes.buffer as ArrayBuffer, {
          contentType: 'image/jpeg',
          upsert: true,
        });
      if (uploadError) throw uploadError;

      const submittedAt = new Date().toISOString();
      const { data, error: recordError } = await supabase
        .from('passenger_selfie_verifications')
        .upsert({
          passenger_id: userData.user.id,
          selfie_path: selfiePath,
          status: 'pending',
          submitted_at: submittedAt,
          reviewed_at: null,
          reviewed_by: null,
        }, { onConflict: 'passenger_id' })
        .select('passenger_id, selfie_path, status, submitted_at, reviewed_at')
        .single();
      if (recordError) throw recordError;

      setSelfieVerification(data as SelfieVerification);
      notify('Selfie submitted', 'Your passenger selfie is waiting for an admin review. Ride requests stay locked until it is approved.');
    } catch (error: any) {
      const message = error.message?.includes('passenger-selfies') || error.code === '42P01' || error.code === 'PGRST205'
        ? 'Selfie storage is not set up yet. Apply the passenger selfie migration in Supabase, then retry.'
        : error.message ?? 'Please try again.';
      notify('Could not submit selfie', message);
    } finally {
      setSelfieBusy(false);
    }
  };

  const loadSelfieReviewQueue = async () => {
    if (!isAdmin) {
      notify('Admin access required', 'This account is not authorized to review passenger selfies.');
      return;
    }

    setReviewQueueBusy(true);
    try {
      const { data, error } = await supabase
        .from('passenger_selfie_verifications')
        .select('passenger_id, selfie_path, status, submitted_at, reviewed_at')
        .eq('status', 'pending')
        .order('submitted_at', { ascending: true });
      if (error) throw error;

      const items = await Promise.all((data ?? []).map(async (record: SelfieVerification) => {
        const { data: signedImage, error: signedImageError } = await supabase.storage
          .from('passenger-selfies')
          .createSignedUrl(record.selfie_path, 5 * 60);
        if (signedImageError) throw signedImageError;
        return { ...record, signed_url: signedImage.signedUrl };
      }));
      setSelfieReviewQueue(items);
    } catch (error: any) {
      notify('Could not load review queue', error.message ?? 'Check that the selfie migration is applied and this account has admin access.');
    } finally {
      setReviewQueueBusy(false);
    }
  };

  const reviewPassengerSelfie = async (item: SelfieReviewItem, status: 'approved' | 'rejected') => {
    setReviewBusyId(item.passenger_id);
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user || userData.user.app_metadata?.role !== 'admin') {
        throw new Error('An authorized admin account is required.');
      }

      const { error } = await supabase
        .from('passenger_selfie_verifications')
        .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: userData.user.id })
        .eq('passenger_id', item.passenger_id);
      if (error) throw error;
      await loadSelfieReviewQueue();
    } catch (error: any) {
      notify('Could not review selfie', error.message ?? 'Please try again.');
    } finally {
      setReviewBusyId('');
    }
  };

  const requestRide = async () => {
    if (!loggedInEmail) {
      notify('Log in first', 'Create an account or log in before requesting a ride.');
      setScreen('login');
      return;
    }

    if (!pickup.trim() || !destination.trim() || !pickupPoint || !destinationPoint) {
      notify(
        'Choose both locations',
        'Set your pickup using My Location or the map, then choose your destination.'
      );
      return;
    }

    const samePlace =
      Math.abs(pickupPoint.latitude - destinationPoint.latitude) < 0.0001 &&
      Math.abs(pickupPoint.longitude - destinationPoint.longitude) < 0.0001;

    if (samePlace) {
      notify('Choose another destination', 'Your pickup and destination are almost the same place.');
      return;
    }

    setBusy(true);

    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();

      if (userError || !userData.user) {
        throw new Error('Your session has expired. Please log in again.');
      }

      const { data: selfieRecord, error: selfieError } = await supabase
        .from('passenger_selfie_verifications')
        .select('passenger_id, selfie_path, status, submitted_at, reviewed_at')
        .eq('passenger_id', userData.user.id)
        .maybeSingle();
      if (selfieError) {
        throw new Error('Passenger selfie verification is not configured. Apply the Supabase selfie migration before accepting rides.');
      }

      const verification = selfieRecord as SelfieVerification | null;
      setSelfieVerification(verification);
      if (verification?.status !== 'approved') {
        setSelfieReturnScreen('ride');
        setScreen('selfie');
        return;
      }

      const rideInsert = {
        passenger_id: userData.user.id,
        pickup_address: pickup.trim(),
        destination_address: destination.trim(),
        pickup_latitude: pickupPoint.latitude,
        pickup_longitude: pickupPoint.longitude,
        destination_latitude: destinationPoint.latitude,
        destination_longitude: destinationPoint.longitude,
        payment_method: 'cash',
        status: 'requested',
        ride_type: selectedRideOption.id,
        passenger_count: passengerCount,
        estimated_fare: fareEstimate ?? null,
        dispatch_status: 'requested',
      };
      let dispatchReady = true;
      const { error: insertError } = await supabase.from('rides').insert(rideInsert);

      if (insertError && isDriverDispatchSchemaMissing(insertError)) {
        const { error: legacyInsertError } = await supabase.from('rides').insert({
          passenger_id: userData.user.id,
          pickup_address: pickup.trim(),
          destination_address: destination.trim(),
          pickup_latitude: pickupPoint.latitude,
          pickup_longitude: pickupPoint.longitude,
          destination_latitude: destinationPoint.latitude,
          destination_longitude: destinationPoint.longitude,
          payment_method: 'cash',
          status: 'requested',
        });
        if (legacyInsertError) throw legacyInsertError;
        dispatchReady = false;
      } else if (insertError) {
        throw insertError;
      }

      notify(
        'Ride request submitted',
        dispatchReady
          ? 'Your request is saved. Nearby eligible drivers can review and accept it. Refresh your ride history to check for updates.'
          : 'Your request was saved, but driver dispatch is not active yet. Apply the driver dispatch migration before drivers can receive requests.'
      );

      setScreen('myrides');
      await loadMyRides();
    } catch (error: any) {
      notify('Ride request failed', error.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const loadMyRides = async () => {
    setRidesBusy(true);

    try {
      let { data, error } = await supabase.rpc('get_passenger_rides');

      if (error && isDriverDispatchSchemaMissing(error)) {
        const { data: legacyRides, error: legacyError } = await supabase
          .from('rides')
          .select('id, pickup_address, destination_address, payment_method, status, created_at')
          .eq('passenger_id', (await supabase.auth.getUser()).data.user?.id ?? '')
          .order('created_at', { ascending: false });
        if (legacyError) throw legacyError;
        data = (legacyRides ?? []).map((ride) => ({ ...ride, dispatch_status: ride.status })) as typeof data;
        error = null;
      }

      if (error) throw error;

      setRides((data ?? []) as Ride[]);
    } catch (error: any) {
      notify('Could not load rides', error.message ?? 'Please try again.');
    } finally {
      setRidesBusy(false);
    }
  };

  const loadDriverProfile = async () => {
    setDriverBusy(true);
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        notify('Log in first', 'Sign in before opening the driver space.');
        setScreen('login');
        return;
      }
      const { data, error } = await supabase.rpc('get_driver_profile');
      if (error) throw error;
      const profile = Array.isArray(data) ? (data[0] as DriverProfile | undefined) : undefined;
      setDriverProfile(profile ?? null);
      setDriverSubscriptionCurrent(Boolean(profile?.subscription_status === 'active' && profile.subscription_renews_at));
      if (profile) {
        setDriverName(profile.full_name);
        setDriverPhone(profile.phone);
        setVehicleMake(profile.vehicle_make);
        setVehicleModel(profile.vehicle_model);
        setVehicleColor(profile.vehicle_color);
        setVehicleRegistration(profile.vehicle_registration);
        setDriverCapacity(String(profile.max_passengers));
        const activeRide = await loadDriverCurrentRide(userData.user.id);
        if (profile.is_available && !activeRide) await refreshDriverRequests(false);
      } else {
        setDriverQueue([]);
        setDriverActiveRide(null);
      }
    } catch (error: any) {
      notify('Driver space unavailable', error.message ?? 'Apply the driver dispatch migration, then try again.');
    } finally {
      setDriverBusy(false);
    }
  };

  const loadDriverCurrentRide = async (userId?: string) => {
    try {
      const id = userId ?? (await supabase.auth.getUser()).data.user?.id;
      if (!id) return;
      const { data, error } = await supabase.from('rides')
        .select('id, pickup_address, destination_address, payment_method, status, created_at, dispatch_status, ride_type, passenger_count, estimated_fare')
        .eq('driver_id', id)
        .in('dispatch_status', ['accepted', 'in_progress'])
        .maybeSingle();
      if (error) throw error;
      setDriverActiveRide(data as Ride | null);
      return data as Ride | null;
    } catch (error: any) {
      notify('Could not load active ride', error.message ?? 'Please refresh and try again.');
      return null;
    }
  };

  const refreshDriverRequests = async (refreshLocation = true) => {
    setDriverBusy(true);
    try {
      if (refreshLocation) {
        let permission = await Location.getForegroundPermissionsAsync();
        if (permission.status !== 'granted') permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== 'granted') throw new Error('Allow location access to go online and see nearby requests.');
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const { error: availabilityError } = await supabase.rpc('set_driver_availability', {
          p_available: true,
          p_latitude: position.coords.latitude,
          p_longitude: position.coords.longitude,
        });
        if (availabilityError) throw availabilityError;
        setDriverProfile((current) => current ? { ...current, is_available: true } : current);
      }
      const { data, error } = await supabase.rpc('get_available_driver_rides');
      if (error) throw error;
      setDriverQueue((data ?? []) as Ride[]);
      await loadDriverCurrentRide();
    } catch (error: any) {
      notify('Could not refresh ride requests', error.message ?? 'Please try again.');
    } finally {
      setDriverBusy(false);
    }
  };

  const toggleDriverAvailability = async () => {
    if (driverProfile?.is_available) {
      setDriverBusy(true);
      try {
        const { error } = await supabase.rpc('set_driver_availability', {
          p_available: false, p_latitude: null, p_longitude: null,
        });
        if (error) throw error;
        setDriverProfile((current) => current ? { ...current, is_available: false } : current);
        setDriverQueue([]);
      } catch (error: any) {
        notify('Could not go offline', error.message ?? 'Please try again.');
      } finally {
        setDriverBusy(false);
      }
    } else {
      await refreshDriverRequests(true);
    }
  };

  const submitDriverApplication = async () => {
    const capacity = Number(driverCapacity);
    if (!loggedInEmail) {
      notify('Log in first', 'Create an account or log in before applying to drive.');
      setScreen('login');
      return;
    }
    if (!driverName.trim() || !driverPhone.trim() || !vehicleMake.trim() || !vehicleModel.trim() || !vehicleColor.trim() || !vehicleRegistration.trim() || !Number.isInteger(capacity) || capacity < 1 || capacity > 6) {
      notify('Complete your application', 'Enter your contact and vehicle details, with a passenger capacity from 1 to 6.');
      return;
    }
    setDriverBusy(true);
    try {
      const { data, error } = await supabase.rpc('register_driver_profile', {
        p_full_name: driverName.trim(), p_phone: driverPhone.trim(),
        p_vehicle_make: vehicleMake.trim(), p_vehicle_model: vehicleModel.trim(),
        p_vehicle_color: vehicleColor.trim(), p_vehicle_registration: vehicleRegistration.trim(),
        p_max_passengers: capacity, p_ride_types: capacity >= 6 ? ['wait_save', 'comfort', 'xl'] : ['wait_save', 'comfort'],
      });
      if (error) throw error;
      const profile = Array.isArray(data) ? data[0] as DriverProfile : data as DriverProfile;
      setDriverProfile(profile);
      setDriverSubscriptionCurrent(false);
      notify('Application submitted', 'Your driver application is pending manual review. You can go online after approval and an active monthly subscription.');
    } catch (error: any) {
      notify('Could not submit application', error.message ?? 'Apply the driver dispatch migration, then try again.');
    } finally {
      setDriverBusy(false);
    }
  };

  const acceptDriverRide = async (ride: Ride) => {
    setDriverBusy(true);
    try {
      const { error } = await supabase.rpc('accept_driver_ride', { p_ride_id: ride.id });
      if (error) throw error;
      await loadDriverProfile();
      notify('Ride accepted', 'You are assigned to this ride. Contact details and route are shown in your active ride.');
    } catch (error: any) {
      notify('Ride not accepted', error.message ?? 'The request may already have been accepted by another driver.');
    } finally {
      setDriverBusy(false);
    }
  };

  const advanceDriverRide = async () => {
    if (!driverActiveRide) return;
    const nextStatus = driverActiveRide.dispatch_status === 'accepted' ? 'in_progress' : 'completed';
    setDriverBusy(true);
    try {
      const { error } = await supabase.rpc('update_driver_ride_status', { p_ride_id: driverActiveRide.id, p_next_status: nextStatus });
      if (error) throw error;
      if (nextStatus === 'completed') setDriverActiveRide(null);
      else setDriverActiveRide({ ...driverActiveRide, dispatch_status: nextStatus });
      if (nextStatus === 'completed') await refreshDriverRequests(true);
    } catch (error: any) {
      notify('Could not update ride', error.message ?? 'Please try again.');
    } finally {
      setDriverBusy(false);
    }
  };

  const loadDriverReviewQueue = async () => {
    setDriverBusy(true);
    try {
      const { data, error } = await supabase.rpc('admin_list_driver_applications');
      if (error) throw error;
      setDriverReviewQueue((data ?? []) as DriverProfile[]);
    } catch (error: any) {
      notify('Could not load driver applications', error.message ?? 'Check admin access and apply the driver migration.');
    } finally {
      setDriverBusy(false);
    }
  };

  const reviewDriver = async (profile: DriverProfile, decision: 'approved' | 'rejected' | 'subscription') => {
    setDriverBusy(true);
    try {
      const result = decision === 'subscription'
        ? await supabase.rpc('admin_record_driver_subscription_month', { p_driver_id: profile.driver_id })
        : await supabase.rpc('admin_review_driver', { p_driver_id: profile.driver_id, p_status: decision });
      if (result.error) throw result.error;
      await loadDriverReviewQueue();
      notify(decision === 'subscription' ? 'Subscription month recorded' : 'Application updated', decision === 'subscription' ? 'One month has been added manually. Confirm the payment was received outside the app.' : `Driver application ${decision}.`);
    } catch (error: any) {
      notify('Could not update driver', error.message ?? 'Please try again.');
    } finally {
      setDriverBusy(false);
    }
  };

  const openMyRides = async () => {
    if (!loggedInEmail) {
      notify('Log in first', 'Log in to see your ride requests.');
      setScreen('login');
      return;
    }

    setScreen('myrides');
    await loadMyRides();
  };

  const selectNavigationTab = (tab: NavigationTab) => {
    if (tab === 'home') setScreen('home');
    else if (tab === 'rides') void openMyRides();
    else setScreen('account');
  };

  if (!isAppReady) {
    if (Platform.OS !== 'web') return null;

    return (
      <View style={styles.startupLoadingScreen}>
        <StatusBar barStyle="dark-content" />
        <Image
          source={require('./assets/lumo-logo-lockup.png')}
          style={styles.startupLoadingImage}
          resizeMode="contain"
          accessibilityLabel="LUMO — Move smarter"
        />
        <ActivityIndicator color="#1769FF" size="small" />
        <Text style={styles.startupLoadingText}>Getting your app ready</Text>
      </View>
    );
  }

  if (screen === 'selfie') {
    const status = selfieVerification?.status;
    const canSubmitSelfie = !status || status === 'rejected';

    return (
      <SafeAreaView style={styles.selfieScreen}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.selfieHeader}>
          <TouchableOpacity style={styles.selfieCloseButton} onPress={() => setScreen(selfieReturnScreen)} accessibilityLabel="Close selfie verification">
            <Text style={styles.selfieCloseText}>×</Text>
          </TouchableOpacity>
          <Text style={styles.selfieHeaderTitle}>Passenger safety</Text>
          <View style={styles.selfieHeaderSpacer} />
        </View>
        <ScrollView contentContainerStyle={styles.selfieContent} keyboardShouldPersistTaps="handled">
          <View style={styles.selfieIntroIcon}><Text style={styles.selfieIntroIconText}>◎</Text></View>
          <Text style={styles.selfieTitle}>Verify with a selfie</Text>
          <Text style={styles.selfieDescription}>
            Take a clear photo of yourself. An authorized LUMO admin will review it before you can request a ride.
          </Text>

          {selfiePreviewUri !== '' && (
            <Image source={{ uri: selfiePreviewUri }} style={styles.selfiePreview} resizeMode="cover" />
          )}

          {status === 'pending' && (
            <View style={styles.selfieStatusCard}>
              <Text style={styles.selfieStatusTitle}>Waiting for review</Text>
              <Text style={styles.selfieStatusCopy}>Your selfie was submitted. Ride requests remain unavailable until an admin approves it.</Text>
            </View>
          )}
          {status === 'approved' && (
            <View style={[styles.selfieStatusCard, styles.selfieStatusApproved]}>
              <Text style={styles.selfieStatusTitle}>Selfie approved</Text>
              <Text style={styles.selfieStatusCopy}>You can now request rides from this passenger account.</Text>
            </View>
          )}
          {status === 'rejected' && (
            <View style={[styles.selfieStatusCard, styles.selfieStatusRejected]}>
              <Text style={styles.selfieStatusTitle}>A new selfie is needed</Text>
              <Text style={styles.selfieStatusCopy}>Retake a clear, recent photo with your face visible. Ride requests stay locked until approval.</Text>
            </View>
          )}

          {canSubmitSelfie && (
            <TouchableOpacity style={[styles.selfieSubmitButton, selfieBusy && styles.disabledButton]} onPress={() => void captureAndSubmitSelfie()} disabled={selfieBusy}>
              {selfieBusy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.selfieSubmitText}>{status === 'rejected' ? 'Retake selfie' : 'Take selfie'}</Text>}
            </TouchableOpacity>
          )}
          {status === 'approved' && (
            <TouchableOpacity style={styles.selfieSubmitButton} onPress={() => setScreen(selfieReturnScreen)}>
              <Text style={styles.selfieSubmitText}>Continue</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.selfiePrivacyNote}>Your photo is kept in private storage and is available only to authorized admins for review.</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === 'review') {
    return (
      <SafeAreaView style={styles.selfieScreen}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.selfieHeader}>
          <TouchableOpacity style={styles.selfieCloseButton} onPress={() => setScreen('account')} accessibilityLabel="Close review queue">
            <Text style={styles.selfieCloseText}>×</Text>
          </TouchableOpacity>
          <Text style={styles.selfieHeaderTitle}>Selfie review</Text>
          <TouchableOpacity style={styles.reviewRefreshButton} onPress={() => void loadSelfieReviewQueue()} accessibilityLabel="Refresh selfie review queue">
            <Text style={styles.reviewRefreshText}>↻</Text>
          </TouchableOpacity>
        </View>
        {!isAdmin ? (
          <View style={styles.reviewEmptyState}><Text style={styles.reviewEmptyTitle}>Admin access required</Text><Text style={styles.reviewEmptyCopy}>This account cannot review passenger selfies.</Text></View>
        ) : reviewQueueBusy ? (
          <ActivityIndicator color="#1769FF" size="large" style={{ marginTop: 32 }} />
        ) : selfieReviewQueue.length === 0 ? (
          <View style={styles.reviewEmptyState}><Text style={styles.reviewEmptyTitle}>No pending selfies</Text><Text style={styles.reviewEmptyCopy}>New passenger submissions will appear here.</Text></View>
        ) : (
          <ScrollView contentContainerStyle={styles.reviewQueueContent}>
            {selfieReviewQueue.map((item) => (
              <View key={item.passenger_id} style={styles.reviewCard}>
                <Image source={{ uri: item.signed_url }} style={styles.reviewSelfieImage} resizeMode="cover" />
                <Text style={styles.reviewPassengerId}>Passenger · {item.passenger_id.slice(-8)}</Text>
                <Text style={styles.reviewSubmittedAt}>Submitted {new Date(item.submitted_at).toLocaleString()}</Text>
                <View style={styles.reviewDecisionRow}>
                  <TouchableOpacity style={styles.reviewRejectButton} onPress={() => void reviewPassengerSelfie(item, 'rejected')} disabled={reviewBusyId !== ''}>
                    {reviewBusyId === item.passenger_id ? <ActivityIndicator color="#171A21" /> : <Text style={styles.reviewRejectText}>Reject</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.reviewApproveButton} onPress={() => void reviewPassengerSelfie(item, 'approved')} disabled={reviewBusyId !== ''}>
                    {reviewBusyId === item.passenger_id ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.reviewApproveText}>Approve</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    );
  }

  if (screen === 'search') {
    const hasLiveQuery = destination.trim().length >= 3;

    return (
      <SafeAreaView style={styles.routeSearchScreen}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.routeSearchHeader}>
          <TouchableOpacity
            style={styles.routeCloseButton}
            onPress={() => { Keyboard.dismiss(); setDestinationFocused(false); setScreen('home'); }}
            accessibilityRole="button"
            accessibilityLabel="Close route search"
          >
            <Text style={styles.routeCloseText}>×</Text>
          </TouchableOpacity>
          <Text style={styles.routeSearchTitle}>Your route</Text>
          <View style={styles.routeHeaderSpacer} />
        </View>

        <KeyboardAvoidingView style={styles.routeSearchContent} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.routeSearchFields}>
            <View style={styles.routeSearchFieldRow}>
              <TouchableOpacity
                style={styles.routeSearchField}
                onPress={() => { setMapTarget('pickup'); setDestinationFocused(false); setScreen('ride'); }}
                accessibilityRole="button"
                accessibilityLabel="Set pickup on map"
              >
                <View style={styles.routePickupIndicator}><View style={styles.routePickupIndicatorCore} /></View>
                <Text numberOfLines={1} style={pickup ? styles.routeSearchValue : styles.routeSearchPlaceholder}>
                  {pickup || 'Set pickup location'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.routeSearchLocateButton} onPress={useMyLocation} accessibilityLabel="Use current location for pickup">
                {locationBusy ? <ActivityIndicator size="small" color="#1769FF" /> : <Text style={styles.routeLocateGlyph}>◎</Text>}
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.routeSwapButton}
              onPress={() => {
                const previousPickup = pickup;
                const previousPickupPoint = pickupPoint;
                setPickup(destination);
                setPickupPoint(destinationPoint);
                setDestination(previousPickup);
                setDestinationPoint(previousPickupPoint);
                setPickupIsCurrentLocation(false);
                setMapTarget('destination');
              }}
              accessibilityRole="button"
              accessibilityLabel="Swap pickup and destination"
            >
              <Text style={styles.routeSwapGlyph}>↕</Text>
            </TouchableOpacity>

            <View style={[styles.routeSearchField, styles.routeDestinationField, styles.routeSearchFieldActive]}>
              <SearchIcon />
              <TextInput
                autoFocus
                style={styles.routeSearchInput}
                placeholder="Search a street or place"
                placeholderTextColor="#737B87"
                value={destination}
                onFocus={() => { setDestinationFocused(true); setMapTarget('destination'); }}
                onChangeText={handleDestinationChange}
                onSubmitEditing={() => void searchDestination(undefined, true)}
                returnKeyType="search"
                accessibilityLabel="Dropoff location"
                selectionColor="#1769FF"
              />
              <TouchableOpacity
                style={styles.routeSearchSubmit}
                onPress={() => void searchDestination(undefined, true)}
                disabled={searchBusy}
                accessibilityRole="button"
                accessibilityLabel="Search this destination"
              >
                {searchBusy ? <ActivityIndicator size="small" color="#1769FF" /> : <Text style={styles.routeSearchSubmitGlyph}>→</Text>}
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.routeSuggestionsPanel}>
            <View style={styles.routeSuggestionsHeader}>
              <Text style={styles.routeSuggestionsTitle}>{hasLiveQuery ? 'Matching places' : 'Search suggestions'}</Text>
              {hasLiveQuery && !suggestionsLoading && locationSuggestions.length > 0 && (
                <Text style={styles.routeSuggestionsCount}>{locationSuggestions.length} found</Text>
              )}
            </View>

            {suggestionsLoading && (
              <View style={styles.routeSearchLoading}>
                <ActivityIndicator size="small" color="#1769FF" />
                <Text style={styles.routeSearchLoadingText}>Looking up real streets and places…</Text>
              </View>
            )}
            {!hasLiveQuery && (
              <View style={styles.routeSearchHint}>
                <View style={styles.routeSearchHintIcon}><SearchIcon /></View>
                <Text style={styles.routeSearchMessage}>Type at least 3 letters to see matching streets and places.</Text>
              </View>
            )}
            {hasLiveQuery && suggestionsMessage !== '' && <Text style={styles.routeSearchMessage}>{suggestionsMessage}</Text>}

            <ScrollView
              style={styles.routeSuggestionsList}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
            >
              {locationSuggestions.map((suggestion, index) => {
                const [title, ...addressParts] = suggestion.label.split(',');
                const address = addressParts.join(',').trim();
                return (
                  <TouchableOpacity
                    key={`${suggestion.label}-${index}`}
                    style={styles.routeSuggestionRow}
                    onPress={() => chooseLocationSuggestion(suggestion, true)}
                    activeOpacity={0.72}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${suggestion.label}`}
                  >
                    <View style={styles.routeSuggestionIcon}><Text style={styles.routeSuggestionIconText}>⌖</Text></View>
                    <View style={styles.routeSuggestionCopy}>
                      <Text style={styles.routeSuggestionName} numberOfLines={1}>{title.trim()}</Text>
                      <Text style={styles.routeSuggestionAddress} numberOfLines={2}>{address || 'Street or place result'}</Text>
                    </View>
                    <Text style={styles.routeSuggestionArrow}>›</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          <View style={styles.routeSearchFooter}>
            <Text style={styles.routeSearchFooterText}>
              {routeFareEstimate ? `Approx. ${routeFareEstimate.distanceKm.toFixed(1)} km estimate · road route and duration unavailable` : 'Choose a place to preview it on the map.'}
            </Text>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (screen === 'ride') {
    return (
      <View style={[styles.fullMapScreen, Platform.OS === 'web' && styles.webMapPreviewFrame]}>
        <StatusBar barStyle="dark-content" />

        {Platform.OS === 'web' ? (
          React.createElement('iframe', {
            title: 'Interactive OpenStreetMap preview',
            src: previewMapUrl,
            loading: 'eager',
            referrerPolicy: 'strict-origin-when-cross-origin',
            style: {
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              width: '100%',
              height: '100%',
              border: 0,
            },
          })
        ) : Platform.OS === 'ios' || Platform.OS === 'android' ? (
          <MapView
            provider={GOOGLE_MAP_PROVIDER}
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            initialCamera={DEFAULT_CAMERA}
            mapType="standard"
            showsPointsOfInterests
            showsBuildings
            showsTraffic
            showsUserLocation={locationPermissionGranted}
            onPanDrag={() => { followLiveLocationRef.current = false; }}
            onPress={onMapPress}
          >
            {headingConeCoordinates && (
              <Polygon
                coordinates={headingConeCoordinates}
                fillColor="#1769FF24"
                strokeColor="#1769FF40"
                strokeWidth={1}
              />
            )}
            {pickupPoint && !pickupIsCurrentLocation && <Marker coordinate={pickupPoint} title="Pickup" anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false}><MapPickupMarker /></Marker>}
            {destinationPoint && <Marker coordinate={destinationPoint} title="Destination" pinColor="#171A21" />}
          </MapView>
        ) : (
          <View style={styles.mapUnavailable}>
            <Text style={styles.mapUnavailableText}>Open the app on iOS or Android to use the interactive map.</Text>
          </View>
        )}

        <SafeAreaView style={styles.mapOverlay} pointerEvents="box-none">
          <View style={styles.mapHeader}>
            <TouchableOpacity style={styles.backButton} onPress={() => setScreen('home')}>
              <Text style={styles.backButtonText}>‹</Text>
            </TouchableOpacity>

            <View style={styles.mapHeaderText}>
              <View style={styles.rideStepMark}><Text style={styles.rideStepMarkText}>02</Text></View>
              <View>
                <Text style={styles.mapHeaderKicker}>TRIP SETUP</Text>
                <Text style={styles.mapHeaderSubtitle}>Ride and details</Text>
              </View>
            </View>

            <TouchableOpacity style={styles.myLocationButton} onPress={useMyLocation}>
              {locationBusy ? (
                <ActivityIndicator color="#1769FF" />
              ) : (
                <Text style={styles.locationIcon}>⌖</Text>
              )}
            </TouchableOpacity>
          </View>

        </SafeAreaView>
        <KeyboardAvoidingView
          style={styles.sheetKeyboardOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
          pointerEvents="box-none"
        >
          <ScrollView
            style={[styles.bookingPanel, destinationFocused && styles.bookingPanelExpanded]}
            contentContainerStyle={styles.bookingPanelContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            <View style={styles.panelGrabber} />
            <View style={styles.bookingEyebrow}>
              <View style={styles.bookingEyebrowMark} />
              <Text style={styles.bookingEyebrowText}>TRIP SETUP · 01</Text>
            </View>
            <Text style={styles.panelTitle}>Build your trip</Text>
            <Text style={styles.panelSubtitle}>Set your stops, ride and passenger count.</Text>

            <View style={styles.targetRow}>
              <TouchableOpacity
                style={[styles.targetButton, mapTarget === 'pickup' && styles.targetSelected]}
                onPress={() => setMapTarget('pickup')}
              >
                <Text style={[styles.targetText, mapTarget === 'pickup' && styles.targetTextSelected]}>
                  1. Pickup
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.targetButton, mapTarget === 'destination' && styles.targetSelected]}
                onPress={() => setMapTarget('destination')}
              >
                <Text
                  style={[
                    styles.targetText,
                    mapTarget === 'destination' && styles.targetTextSelected,
                  ]}
                >
                  2. Destination
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.locationInput} onPress={useMyLocation}>
              <PickupPinIcon />
              <Text style={pickup ? styles.locationValue : styles.locationPlaceholder} numberOfLines={2}>
                {pickup || 'Use my current location for pickup'}
              </Text>
            </TouchableOpacity>

            <View style={styles.searchRow}>
              <TextInput
                style={styles.destinationInput}
                placeholder="Enter destination address or place"
                placeholderTextColor="#8A94A3"
                value={destination}
                onChangeText={handleDestinationChange}
                onFocus={() => {
                  setDestinationFocused(true);
                  setMapTarget('destination');
                }}
                returnKeyType="search"
                onSubmitEditing={() => void searchDestination()}
              />
              <TouchableOpacity
                style={styles.searchButton}
                onPress={() => void searchDestination()}
                disabled={searchBusy}
              >
                {searchBusy ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.searchButtonText}>Find</Text>
                )}
              </TouchableOpacity>
            </View>

            {destinationFocused && destination.trim().length >= 3 && (
              <View style={styles.locationSuggestions}>
                {suggestionsLoading && (
                  <View style={styles.suggestionsLoadingRow}>
                    <ActivityIndicator size="small" color="#1769FF" />
                    <Text style={styles.suggestionsMessage}>Finding places…</Text>
                  </View>
                )}
                {locationSuggestions.map((suggestion, index) => (
                  <TouchableOpacity
                    key={`${suggestion.label}-${index}`}
                    style={styles.locationSuggestionRow}
                    onPress={() => chooseLocationSuggestion(suggestion)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.suggestionPin}><Text style={styles.suggestionPinText}>⌖</Text></View>
                    <Text style={styles.locationSuggestionText} numberOfLines={2}>{suggestion.label}</Text>
                    <Text style={styles.suggestionArrow}>›</Text>
                  </TouchableOpacity>
                ))}
                {!suggestionsLoading && suggestionsMessage !== '' && (
                  <Text style={styles.suggestionsMessage}>{suggestionsMessage}</Text>
                )}
              </View>
            )}

            <Text style={styles.cashLabel}>PAYMENT METHOD</Text>
            <View style={styles.cashBox}>
              <Text style={styles.cashIcon}>R</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.cashTitle}>Cash</Text>
                <Text style={styles.cashSubtitle}>Pay the driver in cash</Text>
              </View>
              <Text style={styles.cashCheck}>✓</Text>
            </View>

            <View style={styles.fareEstimateCard}>
              <View style={styles.fareEstimateHeader}>
                <View>
                  <Text style={styles.fareEstimateTitle}>Estimated fare</Text>
                  <Text style={styles.fareEstimateDistance}>
                    {routeFareEstimate ? `Approx. ${routeFareEstimate.distanceKm.toFixed(1)} km · ${selectedRideOption.title}` : 'Select both locations to calculate'}
                  </Text>
                </View>
                <Text style={styles.fareEstimateAmount}>
                  {fareEstimate !== null ? `R${fareEstimate}` : 'R—'}
                </Text>
              </View>
              <Text style={styles.fareEstimateNote}>
                Example rates: Wait & Save R5 + R5/km, Comfort +20%, XL +50%. Actual route and fare may differ.
              </Text>
            </View>

            <Text style={styles.packageSectionLabel}>CHOOSE A RIDE</Text>
            <View style={styles.rideOptionRow}>
              {RIDE_OPTIONS.map((option, index) => {
                const optionFare = calculateOptionFare(routeFareEstimate?.fareZar ?? null, option);
                const isSelected = option.id === selectedRideOptionId;

                return (
                  <TouchableOpacity
                    key={option.id}
                    style={[styles.rideOptionCard, isSelected && styles.rideOptionCardSelected]}
                    onPress={() => chooseRideOption(option)}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                  >
                    <View style={styles.rideOptionTopline}>
                      <Text style={[styles.rideOptionIndex, isSelected && styles.rideOptionIndexSelected]}>
                        0{index + 1}
                      </Text>
                      {isSelected && <View style={styles.rideOptionSelectedMark} />}
                    </View>
                    <Text style={[styles.rideOptionTitle, isSelected && styles.rideOptionTitleSelected]} numberOfLines={2}>
                      {option.title}
                    </Text>
                    <Text style={styles.rideOptionDetail} numberOfLines={1}>{option.detail}</Text>
                    <Text style={styles.rideOptionFare}>{optionFare !== null ? `R${optionFare}` : 'R—'}</Text>
                    <Text style={styles.rideOptionCapacity}>Up to {option.maxPassengers}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.passengerSelector}>
              <View>
                <Text style={styles.passengerLabel}>Passengers</Text>
                <Text style={styles.passengerHint}>Including you · up to {selectedRideOption.maxPassengers}</Text>
              </View>
              <View style={styles.passengerStepper}>
                <TouchableOpacity
                  style={[styles.stepperButton, passengerCount <= 1 && styles.stepperButtonDisabled]}
                  onPress={() => setPassengerCount((count) => Math.max(1, count - 1))}
                  disabled={passengerCount <= 1}
                  accessibilityRole="button"
                  accessibilityLabel="Remove one passenger"
                >
                  <Text style={styles.stepperButtonText}>−</Text>
                </TouchableOpacity>
                <Text style={styles.passengerCount}>{passengerCount}</Text>
                <TouchableOpacity
                  style={[styles.stepperButton, passengerCount >= selectedRideOption.maxPassengers && styles.stepperButtonDisabled]}
                  onPress={() => setPassengerCount((count) => Math.min(selectedRideOption.maxPassengers, count + 1))}
                  disabled={passengerCount >= selectedRideOption.maxPassengers}
                  accessibilityRole="button"
                  accessibilityLabel="Add one passenger"
                >
                  <Text style={styles.stepperButtonText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            <PrimaryButton title="Request a ride" onPress={requestRide} disabled={busy} />
            <Text style={styles.smallNote}>
              Cash to the driver. Your fare is an estimate; the request is accepted only when an eligible driver takes it.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  if (screen === 'signup' || screen === 'login') {
    const isSignup = screen === 'signup';

    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={styles.authContainer} keyboardShouldPersistTaps="handled">
            <TouchableOpacity style={styles.authBack} onPress={() => setScreen('home')}>
              <Text style={styles.authBackText}>‹ Back</Text>
            </TouchableOpacity>

            <View style={styles.logoMark}>
              <Text style={styles.logoMarkText}>L</Text>
            </View>
            <Text style={styles.authTitle}>{isSignup ? 'Create your account' : 'Welcome back'}</Text>
            <Text style={styles.authSubtitle}>
              {isSignup ? 'Your next ride starts here.' : 'Log in to continue your journey.'}
            </Text>

            <Text style={styles.fieldLabel}>Email address</Text>
            <TextInput
              style={styles.textInput}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor="#8A94A3"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.fieldLabel}>Password</Text>
            <TextInput
              style={styles.textInput}
              value={password}
              onChangeText={setPassword}
              placeholder="At least 6 characters"
              placeholderTextColor="#8A94A3"
              secureTextEntry
              autoCapitalize="none"
            />

            <PrimaryButton
              title={busy ? 'Please wait...' : isSignup ? 'Create account' : 'Log in'}
              onPress={isSignup ? signUp : logIn}
              disabled={busy}
            />

            <TouchableOpacity
              style={styles.authSwitch}
              onPress={() => setScreen(isSignup ? 'login' : 'signup')}
            >
              <Text style={styles.authSwitchText}>
                {isSignup ? 'Already have an account? Log in' : 'Need an account? Create one'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (screen === 'driver-review') {
    return (
      <SafeAreaView style={styles.accountScreen}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.pageHeader}>
          <TouchableOpacity style={styles.backButton} onPress={() => setScreen('account')} accessibilityRole="button" accessibilityLabel="Back to account"><Text style={styles.backButtonText}>‹</Text></TouchableOpacity>
          <Text style={styles.pageTitle}>Driver applications</Text>
          <TouchableOpacity style={styles.ridesRefreshButton} onPress={() => void loadDriverReviewQueue()} disabled={driverBusy}>{driverBusy ? <ActivityIndicator size="small" color="#1769FF" /> : <Text style={styles.ridesRefreshText}>Refresh</Text>}</TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.driverPanelContent}>
          <Text style={styles.sectionDescription}>Review identity and vehicle documents outside this screen before approving. Subscription months are recorded manually after payment is received.</Text>
          {driverReviewQueue.length === 0 && !driverBusy ? <View style={styles.emptyState}><Text style={styles.emptyTitle}>No applications</Text><Text style={styles.emptyText}>New driver applications will appear here.</Text></View> : null}
          {driverReviewQueue.map((profile) => (
            <View style={styles.driverCard} key={profile.driver_id}>
              <Text style={styles.driverCardTitle}>{profile.full_name}</Text>
              <Text style={styles.driverCardText}>{profile.phone}</Text>
              <Text style={styles.driverCardText}>{[profile.vehicle_color, profile.vehicle_make, profile.vehicle_model, profile.vehicle_registration].filter(Boolean).join(' · ')}</Text>
              <Text style={styles.driverCardMeta}>Up to {profile.max_passengers} riders · {profile.ride_types.join(', ')}</Text>
              <Text style={styles.driverCardMeta}>Application: {profile.application_status} · Subscription: {profile.subscription_status}{profile.subscription_renews_at ? ` until ${new Date(profile.subscription_renews_at).toLocaleDateString()}` : ''}</Text>
              <View style={styles.driverActionRow}>
                {profile.application_status !== 'approved' && <TouchableOpacity style={styles.driverSmallButton} onPress={() => void reviewDriver(profile, 'approved')} disabled={driverBusy}><Text style={styles.driverSmallButtonText}>Approve</Text></TouchableOpacity>}
                {profile.application_status !== 'rejected' && <TouchableOpacity style={styles.driverSecondaryButton} onPress={() => void reviewDriver(profile, 'rejected')} disabled={driverBusy}><Text style={styles.driverSecondaryButtonText}>Reject</Text></TouchableOpacity>}
                {profile.application_status === 'approved' && <TouchableOpacity style={styles.driverSmallButton} onPress={() => void reviewDriver(profile, 'subscription')} disabled={driverBusy}><Text style={styles.driverSmallButtonText}>Record paid month</Text></TouchableOpacity>}
              </View>
            </View>
          ))}
        </ScrollView>
        <BottomNavigation active="account" onHome={() => selectNavigationTab('home')} onRides={() => selectNavigationTab('rides')} onAccount={() => selectNavigationTab('account')} />
      </SafeAreaView>
    );
  }

  if (screen === 'driver') {
    return (
      <SafeAreaView style={styles.accountScreen}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.pageHeader}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => setScreen('account')}
            accessibilityRole="button"
            accessibilityLabel="Back to account"
          >
            <Text style={styles.backButtonText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.pageTitle}>Driver space</Text>
          <TouchableOpacity style={styles.ridesRefreshButton} onPress={() => void loadDriverProfile()} disabled={driverBusy}>{driverBusy ? <ActivityIndicator size="small" color="#1769FF" /> : <Text style={styles.ridesRefreshText}>Refresh</Text>}</TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.driverPanelContent}>
          {!loggedInEmail ? (
            <View style={styles.driverCard}>
              <Text style={styles.driverCardTitle}>Sign in to drive with LUMO</Text>
              <Text style={styles.driverCardText}>Submit your driver and vehicle details from your account.</Text>
              <TouchableOpacity style={styles.driverPrimaryButton} onPress={() => setScreen('login')}><Text style={styles.driverPrimaryButtonText}>Log in</Text></TouchableOpacity>
              <TouchableOpacity style={styles.driverSecondaryButton} onPress={() => setScreen('signup')}><Text style={styles.driverSecondaryButtonText}>Create account</Text></TouchableOpacity>
            </View>
          ) : !driverProfile ? (
            <View style={styles.driverCard}>
              <Text style={styles.driverCardTitle}>Apply to drive</Text>
              <Text style={styles.driverCardText}>Applications are reviewed manually. Driver access is enabled only after approval and monthly subscription activation.</Text>
              <Text style={styles.fieldLabel}>Full name</Text><TextInput style={styles.textInput} value={driverName} onChangeText={setDriverName} placeholder="Full name" placeholderTextColor="#8A94A3" />
              <Text style={styles.fieldLabel}>Phone number</Text><TextInput style={styles.textInput} value={driverPhone} onChangeText={setDriverPhone} placeholder="Phone number" placeholderTextColor="#8A94A3" keyboardType="phone-pad" />
              <Text style={styles.fieldLabel}>Vehicle make</Text><TextInput style={styles.textInput} value={vehicleMake} onChangeText={setVehicleMake} placeholder="e.g. Toyota" placeholderTextColor="#8A94A3" />
              <Text style={styles.fieldLabel}>Vehicle model</Text><TextInput style={styles.textInput} value={vehicleModel} onChangeText={setVehicleModel} placeholder="e.g. Corolla" placeholderTextColor="#8A94A3" />
              <Text style={styles.fieldLabel}>Vehicle colour</Text><TextInput style={styles.textInput} value={vehicleColor} onChangeText={setVehicleColor} placeholder="Colour" placeholderTextColor="#8A94A3" />
              <Text style={styles.fieldLabel}>Registration plate</Text><TextInput style={styles.textInput} value={vehicleRegistration} onChangeText={setVehicleRegistration} placeholder="Registration" placeholderTextColor="#8A94A3" autoCapitalize="characters" />
              <Text style={styles.fieldLabel}>Passenger capacity (1–6)</Text><TextInput style={styles.textInput} value={driverCapacity} onChangeText={setDriverCapacity} placeholder="4" placeholderTextColor="#8A94A3" keyboardType="number-pad" />
              <Text style={styles.driverCardMeta}>Wait &amp; Save and Comfort are available for all vehicles. XL is included for capacity 6.</Text>
              <TouchableOpacity style={[styles.driverPrimaryButton, driverBusy && styles.disabledButton]} onPress={() => void submitDriverApplication()} disabled={driverBusy}>{driverBusy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.driverPrimaryButtonText}>Submit application</Text>}</TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={styles.driverCard}>
                <Text style={styles.driverCardEyebrow}>DRIVER STATUS</Text>
                <Text style={styles.driverCardTitle}>{driverProfile.full_name}</Text>
                <Text style={styles.driverCardText}>{driverProfile.application_status === 'pending' ? 'Application pending manual review.' : driverProfile.application_status === 'rejected' ? 'Application not approved. Update your details and resubmit.' : 'Application approved.'}</Text>
                <Text style={styles.driverCardMeta}>Monthly subscription: {driverSubscriptionCurrent && driverProfile.subscription_renews_at ? `active until ${new Date(driverProfile.subscription_renews_at).toLocaleDateString()}` : 'inactive or expired'}</Text>
                <Text style={styles.driverCardMeta}>No trip commission. An admin records each month after separately confirming payment.</Text>
                {driverProfile.application_status === 'rejected' && <TouchableOpacity style={styles.driverSecondaryButton} onPress={() => { setDriverProfile(null); setDriverSubscriptionCurrent(false); }}><Text style={styles.driverSecondaryButtonText}>Edit application</Text></TouchableOpacity>}
                {driverProfile.application_status === 'approved' && driverSubscriptionCurrent && <TouchableOpacity style={[styles.driverPrimaryButton, driverProfile.is_available && styles.driverOfflineButton]} onPress={() => void toggleDriverAvailability()} disabled={driverBusy}>{driverBusy ? <ActivityIndicator color={driverProfile.is_available ? '#171A21' : '#FFFFFF'} /> : <Text style={[styles.driverPrimaryButtonText, driverProfile.is_available && styles.driverOfflineButtonText]}>{driverProfile.is_available ? 'Go offline' : 'Go online'}</Text>}</TouchableOpacity>}
                {driverProfile.is_available && <TouchableOpacity style={styles.driverSecondaryButton} onPress={() => void refreshDriverRequests(true)} disabled={driverBusy}><Text style={styles.driverSecondaryButtonText}>Refresh nearby requests</Text></TouchableOpacity>}
                {driverProfile.application_status === 'approved' && !driverSubscriptionCurrent && <Text style={styles.driverCardMeta}>Contact LUMO admin to arrange or renew the subscription. In-app payments are not configured.</Text>}
              </View>
              {driverActiveRide && <View style={styles.driverCard}>
                <Text style={styles.driverCardEyebrow}>ACTIVE RIDE · {driverActiveRide.dispatch_status?.replace(/_/g, ' ').toUpperCase()}</Text>
                <Text style={styles.driverCardTitle}>{driverActiveRide.pickup_address}</Text>
                <Text style={styles.driverCardText}>Drop-off · {driverActiveRide.destination_address}</Text>
                <Text style={styles.driverCardMeta}>{driverActiveRide.passenger_count ?? 1} passenger(s) · Cash · Estimate R{driverActiveRide.estimated_fare ?? '—'}</Text>
                <TouchableOpacity style={styles.driverPrimaryButton} onPress={() => void advanceDriverRide()} disabled={driverBusy}><Text style={styles.driverPrimaryButtonText}>{driverActiveRide.dispatch_status === 'accepted' ? 'Start ride' : 'Complete ride'}</Text></TouchableOpacity>
              </View>}
              {driverProfile.is_available && !driverActiveRide && <View style={styles.driverQueueSection}>
                <Text style={styles.driverCardTitle}>Nearby ride requests</Text>
                <Text style={styles.driverCardText}>Matching requests within about 35 km. Location refreshes when you go online or refresh.</Text>
                {driverQueue.length === 0 ? <Text style={styles.driverEmptyText}>No matching requests right now.</Text> : driverQueue.map((ride) => <View style={styles.driverQueueCard} key={ride.id}>
                  <Text style={styles.driverCardEyebrow}>{ride.ride_type?.replace('_', ' ').toUpperCase()} · {ride.passenger_count} PASSENGER(S)</Text>
                  <Text style={styles.driverQueueRoute}>{ride.pickup_address}</Text><Text style={styles.driverQueueDestination}>to {ride.destination_address}</Text>
                  <Text style={styles.driverCardMeta}>Cash · Passenger estimate R{ride.estimated_fare ?? '—'}</Text>
                  <TouchableOpacity style={styles.driverPrimaryButton} onPress={() => void acceptDriverRide(ride)} disabled={driverBusy}><Text style={styles.driverPrimaryButtonText}>Accept ride</Text></TouchableOpacity>
                </View>)}
              </View>}
            </>
          )}
        </ScrollView>
        <BottomNavigation active="account" onHome={() => selectNavigationTab('home')} onRides={() => selectNavigationTab('rides')} onAccount={() => selectNavigationTab('account')} />
      </SafeAreaView>
    );
  }

  if (screen === 'account') {
    return (
      <SafeAreaView style={styles.accountScreen}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.accountHeader}>
          <View style={styles.profileHeaderRow}>
            {profilePhotoUrl ? (
              <Image source={{ uri: profilePhotoUrl }} style={styles.profilePhoto} accessibilityLabel="Your profile photo" />
            ) : (
              <View style={styles.profilePhotoFallback}><Text style={styles.profilePhotoInitial}>{loggedInEmail ? loggedInEmail.charAt(0).toUpperCase() : 'L'}</Text></View>
            )}
            <View style={styles.profileHeaderCopy}>
              <Text style={styles.accountScreenTitle}>Account</Text>
              <Text style={styles.accountIdentity}>{loggedInEmail || 'Your LUMO account'}</Text>
            </View>
          </View>
          {loggedInEmail && <View style={styles.profilePhotoActions}>
            <TouchableOpacity style={styles.profilePhotoButton} onPress={() => void chooseProfilePhoto()} disabled={profilePhotoBusy} accessibilityRole="button" accessibilityLabel="Choose a profile photo">
              {profilePhotoBusy ? <ActivityIndicator size="small" color="#1769FF" /> : <Text style={styles.profilePhotoButtonText}>{profilePhotoUrl ? 'Change photo' : 'Add profile photo'}</Text>}
            </TouchableOpacity>
            {profilePhotoUrl && <TouchableOpacity style={styles.profilePhotoRemoveButton} onPress={() => void removeProfilePhoto()} disabled={profilePhotoBusy} accessibilityRole="button" accessibilityLabel="Remove profile photo">
              <Text style={styles.profilePhotoRemoveText}>Remove</Text>
            </TouchableOpacity>}
          </View>}
        </View>
        <View style={styles.accountActions}>
          {loggedInEmail ? (
            <>
              <TouchableOpacity style={styles.accountAction} onPress={() => void openPassengerSelfie('account')}>
                <Text style={styles.accountActionText}>Passenger selfie safety</Text><Text style={styles.accountActionArrow}>›</Text>
              </TouchableOpacity>
              {isAdmin && (
                <TouchableOpacity style={styles.accountAction} onPress={() => { setScreen('review'); void loadSelfieReviewQueue(); }}>
                  <Text style={styles.accountActionText}>Review passenger selfies</Text><Text style={styles.accountActionArrow}>›</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.accountAction} onPress={() => void openMyRides()}>
                <Text style={styles.accountActionText}>Ride history</Text><Text style={styles.accountActionArrow}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.accountAction} onPress={() => { setScreen('driver'); void loadDriverProfile(); }}>
                <Text style={styles.accountActionText}>Driver panel</Text><Text style={styles.accountActionArrow}>›</Text>
              </TouchableOpacity>
              {isAdmin && (
                <TouchableOpacity style={styles.accountAction} onPress={() => { setScreen('driver-review'); void loadDriverReviewQueue(); }}>
                  <Text style={styles.accountActionText}>Review driver applications</Text><Text style={styles.accountActionArrow}>›</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.accountAction} onPress={logOut}>
                <Text style={styles.accountActionText}>Log out</Text><Text style={styles.accountActionArrow}>›</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity style={styles.accountAction} onPress={() => setScreen('login')}>
                <Text style={styles.accountActionText}>Log in</Text><Text style={styles.accountActionArrow}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.accountAction} onPress={() => setScreen('signup')}>
                <Text style={styles.accountActionText}>Create an account</Text><Text style={styles.accountActionArrow}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.accountAction} onPress={() => setScreen('login')}>
                <Text style={styles.accountActionText}>Driver panel</Text><Text style={styles.accountActionArrow}>›</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
        <View style={styles.accountNavWrap}>
          <BottomNavigation active="account" onHome={() => selectNavigationTab('home')} onRides={() => selectNavigationTab('rides')} onAccount={() => selectNavigationTab('account')} />
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'myrides') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.ridesHeader}>
          <View>
            <Text style={styles.ridesEyebrow}>YOUR ACTIVITY</Text>
            <Text style={styles.ridesPageTitle}>Rides</Text>
          </View>
          <TouchableOpacity
            style={styles.ridesRefreshButton}
            onPress={() => void loadMyRides()}
            disabled={ridesBusy}
            accessibilityRole="button"
            accessibilityLabel="Refresh rides"
          >
            {ridesBusy ? <ActivityIndicator size="small" color="#1769FF" /> : <Text style={styles.ridesRefreshText}>Refresh</Text>}
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.ridesContainer}>
          <Text style={styles.ridesSectionTitle}>Recent trips</Text>
          <Text style={styles.sectionDescription}>Your ride requests, all in one place.</Text>

          {ridesBusy ? (
            <View style={styles.ridesLoadingState}>
              <ActivityIndicator color="#1769FF" size="large" />
              <Text style={styles.ridesLoadingText}>Loading your rides…</Text>
            </View>
          ) : rides.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyIconWrap}><Text style={styles.emptyIcon}>⌖</Text></View>
              <Text style={styles.emptyTitle}>No rides yet</Text>
              <Text style={styles.emptyText}>Your ride requests will show up here. Book a ride to get started.</Text>
              <PrimaryButton title="Book a ride" onPress={() => setScreen('ride')} />
            </View>
          ) : (
            rides.map((ride) => (
              <View style={styles.rideCard} key={ride.id}>
                <View style={styles.rideCardHeader}>
                  <View style={styles.rideStatusPill}>
                    <Text style={styles.rideStatus}>{(ride.dispatch_status ?? ride.status).replace(/_/g, ' ').toUpperCase()}</Text>
                  </View>
                  <Text style={styles.rideDate}>{new Date(ride.created_at).toLocaleDateString()}</Text>
                </View>
                <View style={styles.rideRouteBlock}>
                  <View style={styles.rideTimeline}>
                    <View style={styles.ridePickupDot} />
                    <View style={styles.rideTimelineLine} />
                    <View style={styles.rideDestinationDot} />
                  </View>
                  <View style={styles.rideStops}>
                    <View style={styles.rideStop}>
                      <Text style={styles.rideLabel}>PICKUP</Text>
                      <Text style={styles.rideAddress}>{ride.pickup_address}</Text>
                    </View>
                    <View style={styles.rideStop}>
                      <Text style={styles.rideLabel}>DESTINATION</Text>
                      <Text style={styles.rideAddress}>{ride.destination_address}</Text>
                    </View>
                  </View>
                </View>
                <View style={styles.rideCardFooter}>
                  <Text style={styles.ridePayment}>Cash · {ride.passenger_count ?? 1} passenger(s){ride.estimated_fare != null ? ` · Estimate R${ride.estimated_fare}` : ''}</Text>
                  {ride.driver_name ? <Text style={styles.ridePayment}>Driver · {ride.driver_name}{ride.driver_phone ? ` · ${ride.driver_phone}` : ''}{ride.driver_vehicle ? ` · ${ride.driver_vehicle}` : ''}</Text> : ride.dispatch_status === 'requested' ? <Text style={styles.ridePayment}>Waiting for a nearby driver to accept</Text> : null}
                </View>
              </View>
            ))
          )}
        </ScrollView>
        <BottomNavigation active="rides" onHome={() => selectNavigationTab('home')} onRides={() => selectNavigationTab('rides')} onAccount={() => selectNavigationTab('account')} />
      </SafeAreaView>
    );
  }

  return (
    <View style={[styles.homeMapScreen, Platform.OS === 'web' && styles.webMapPreviewFrame]}>
      <StatusBar barStyle="dark-content" />
      {Platform.OS === 'web' ? (
        React.createElement('iframe', {
          title: 'Interactive OpenStreetMap preview',
          src: previewMapUrl,
          loading: 'eager',
          referrerPolicy: 'strict-origin-when-cross-origin',
          style: {
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            width: '100%',
            height: '100%',
            border: 0,
          },
        })
      ) : Platform.OS === 'ios' || Platform.OS === 'android' ? (
        <MapView
          provider={GOOGLE_MAP_PROVIDER}
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          initialCamera={DEFAULT_CAMERA}
          mapType="standard"
          showsPointsOfInterests
          showsBuildings
          showsTraffic
          showsUserLocation={locationPermissionGranted}
          onPanDrag={() => { followLiveLocationRef.current = false; }}
          onPress={onMapPress}
        >
          {headingConeCoordinates && (
            <Polygon
              coordinates={headingConeCoordinates}
              fillColor="#1769FF24"
              strokeColor="#1769FF40"
              strokeWidth={1}
            />
          )}
          {pickupPoint && !pickupIsCurrentLocation && <Marker coordinate={pickupPoint} title="Pickup" anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false}><MapPickupMarker /></Marker>}
          {destinationPoint && <Marker coordinate={destinationPoint} title="Destination" pinColor="#171A21" />}
        </MapView>
      ) : (
        <View style={styles.mapUnavailable}>
          <Text style={styles.mapUnavailableText}>Open the app on iOS or Android to use the interactive map.</Text>
        </View>
      )}

      <SafeAreaView style={styles.homeMapOverlay} pointerEvents="box-none">
        <View style={styles.homeMapHeader}>
          <TouchableOpacity style={styles.menuButton} onPress={() => setMenuOpen((open) => !open)} accessibilityRole="button" accessibilityLabel="Open menu">
            <MenuIcon />
          </TouchableOpacity>
          <Text style={styles.homeWordmark}>LUMO</Text>
        </View>
        {menuOpen && (
          <View style={styles.menuPopup}>
            <TouchableOpacity style={styles.menuPopupItem} onPress={() => { setMenuOpen(false); selectNavigationTab('home'); }}><Text style={styles.menuPopupText}>Home</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuPopupItem} onPress={() => { setMenuOpen(false); selectNavigationTab('rides'); }}><Text style={styles.menuPopupText}>Rides</Text></TouchableOpacity>
            <TouchableOpacity style={styles.menuPopupItem} onPress={() => { setMenuOpen(false); selectNavigationTab('account'); }}><Text style={styles.menuPopupText}>Account</Text></TouchableOpacity>
          </View>
        )}

        <View style={styles.mapControls}>
          <TouchableOpacity style={styles.homeLocationButton} onPress={useMyLocation} accessibilityLabel="Use my current location">
            {locationBusy ? <ActivityIndicator color="#1769FF" /> : <LocationTargetIcon />}
          </TouchableOpacity>
        </View>

      </SafeAreaView>
      <View style={styles.homeBookingPanel}>
        <View style={styles.panelGrabber} />
        <TouchableOpacity
          style={styles.whereToField}
          activeOpacity={0.82}
          onPress={() => { setMapTarget('destination'); setDestinationFocused(true); setScreen('search'); }}
          accessibilityRole="button"
          accessibilityLabel={destination ? `Destination ${destination}` : 'Where to?'}
        >
          <SearchIcon />
          <Text numberOfLines={1} style={destination ? styles.whereToValue : styles.whereToPlaceholder}>{destination || 'Where to?'}</Text>
          <Text style={styles.whereToArrow}>›</Text>
        </TouchableOpacity>
        <View style={styles.bottomNavDivider} />
        <BottomNavigation active="home" onHome={() => selectNavigationTab('home')} onRides={() => selectNavigationTab('rides')} onAccount={() => selectNavigationTab('account')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  startupLoadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F3F6F9', paddingHorizontal: 28 },
  startupLoadingImage: { width: '100%', maxWidth: 430, height: 285, marginBottom: 24 },
  startupLoadingText: { color: '#68717D', fontSize: 13, marginTop: 13 },
  selfieScreen: { flex: 1, backgroundColor: '#F0F2F2' },
  selfieHeader: { height: 60, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E9ECEF' },
  selfieCloseButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  selfieCloseText: { color: '#171A21', fontSize: 32, fontWeight: '300', lineHeight: 36 },
  selfieHeaderTitle: { color: '#171A21', fontSize: 17, fontWeight: '800' },
  selfieHeaderSpacer: { width: 42 },
  selfieContent: { alignItems: 'center', paddingHorizontal: 24, paddingTop: 34, paddingBottom: 32 },
  selfieIntroIcon: { width: 76, height: 76, borderRadius: 38, backgroundColor: '#E5EEFF', alignItems: 'center', justifyContent: 'center' },
  selfieIntroIconText: { color: '#1769FF', fontSize: 44, fontWeight: '400' },
  selfieTitle: { color: '#171A21', fontSize: 25, fontWeight: '800', marginTop: 22 },
  selfieDescription: { color: '#68717D', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 10, maxWidth: 330 },
  selfiePreview: { width: 220, height: 220, borderRadius: 20, marginTop: 24, backgroundColor: '#E1E5E8' },
  selfieStatusCard: { width: '100%', padding: 16, marginTop: 24, borderRadius: 14, backgroundColor: '#FFF4D6', borderWidth: 1, borderColor: '#F0D58E' },
  selfieStatusApproved: { backgroundColor: '#E7F7ED', borderColor: '#B8E2C6' },
  selfieStatusRejected: { backgroundColor: '#FFF0EE', borderColor: '#F1C5BE' },
  selfieStatusTitle: { color: '#171A21', fontSize: 15, fontWeight: '800' },
  selfieStatusCopy: { color: '#596270', fontSize: 13, lineHeight: 19, marginTop: 5 },
  selfieSubmitButton: { width: '100%', minHeight: 54, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1769FF', borderRadius: 15, marginTop: 24 },
  selfieSubmitText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  selfiePrivacyNote: { color: '#7B8491', fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 18 },
  reviewRefreshButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  reviewRefreshText: { color: '#1769FF', fontSize: 25 },
  reviewQueueContent: { padding: 16, paddingBottom: 32 },
  reviewCard: { padding: 16, marginBottom: 16, backgroundColor: '#FFFFFF', borderRadius: 18, borderWidth: 1, borderColor: '#E5E8EB' },
  reviewSelfieImage: { width: '100%', height: 300, borderRadius: 12, backgroundColor: '#E1E5E8' },
  reviewPassengerId: { color: '#171A21', fontSize: 14, fontWeight: '700', marginTop: 14 },
  reviewSubmittedAt: { color: '#737B87', fontSize: 12, marginTop: 4 },
  reviewDecisionRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  reviewRejectButton: { flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0F2F2' },
  reviewRejectText: { color: '#171A21', fontSize: 14, fontWeight: '700' },
  reviewApproveButton: { flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1769FF' },
  reviewApproveText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  reviewEmptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  reviewEmptyTitle: { color: '#171A21', fontSize: 18, fontWeight: '800', textAlign: 'center' },
  reviewEmptyCopy: { color: '#6D7682', fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8 },
  routeSearchScreen: { flex: 1, backgroundColor: '#F0F2F2' },
  routeSearchHeader: { height: 62, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#EEF0F2' },
  routeCloseButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  routeCloseText: { color: '#171A21', fontSize: 34, fontWeight: '300', lineHeight: 38 },
  routeSearchTitle: { position: 'absolute', left: 55, right: 55, textAlign: 'center', color: '#171A21', fontSize: 20, fontWeight: '800' },
  routeHeaderSpacer: { width: 44 },
  routeSearchContent: { flex: 1 },
  routeSearchFields: { marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 22, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7E9E9', shadowColor: '#171A21', shadowOpacity: 0.05, shadowRadius: 9, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  routeSearchFieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  routeSearchField: { minHeight: 58, flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#F0F2F2', borderColor: '#E3E6E8', borderWidth: 1, borderRadius: 14, paddingHorizontal: 15 },
  routeSearchFieldActive: { borderColor: '#1769FF', borderWidth: 1.5, backgroundColor: '#FFFFFF' },
  routePickupIndicator: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#EEE9FF', borderWidth: 1.5, borderColor: '#6956D9', alignItems: 'center', justifyContent: 'center', marginRight: 13 },
  routePickupIndicatorCore: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#6956D9' },
  routeSearchValue: { flex: 1, color: '#171A21', fontSize: 15, fontWeight: '600' },
  routeSearchPlaceholder: { flex: 1, color: '#737B87', fontSize: 15 },
  routeSearchLocateButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#F0F2F2' },
  routeLocateGlyph: { color: '#1769FF', fontSize: 22, fontWeight: '600' },
  routeSwapButton: { height: 34, width: 42, alignSelf: 'flex-end', alignItems: 'center', justifyContent: 'center', marginRight: 50, marginVertical: 1 },
  routeSwapGlyph: { color: '#49515C', fontSize: 24, fontWeight: '500' },
  routeDestinationField: { flex: 0, minHeight: 60, borderRadius: 14, paddingRight: 8 },
  routeSearchInput: { flex: 1, minWidth: 0, color: '#171A21', fontSize: 15, paddingVertical: 12, marginLeft: 12 },
  routeSearchSubmit: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#FFFFFF' },
  routeSearchSubmitGlyph: { color: '#1769FF', fontSize: 25, fontWeight: '500' },
  routeSuggestionsPanel: { flex: 1, minHeight: 0, marginHorizontal: 16, marginTop: 10, marginBottom: 6, borderRadius: 22, overflow: 'hidden', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7E9E9', shadowColor: '#171A21', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  routeSuggestionsHeader: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#F0F1F2' },
  routeSuggestionsTitle: { color: '#171A21', fontSize: 15, fontWeight: '700' },
  routeSuggestionsCount: { color: '#68717D', fontSize: 11, fontWeight: '600' },
  routeSearchLoading: { flexDirection: 'row', gap: 9, alignItems: 'center', paddingHorizontal: 22, paddingVertical: 10 },
  routeSearchLoadingText: { color: '#68717D', fontSize: 13 },
  routeSearchHint: { minHeight: 78, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12 },
  routeSearchHintIcon: { width: 38, height: 38, borderRadius: 13, backgroundColor: '#F0F2F2', alignItems: 'center', justifyContent: 'center' },
  routeSearchMessage: { flex: 1, color: '#69727E', fontSize: 12, lineHeight: 18, paddingVertical: 11 },
  routeSuggestionsList: { flex: 1, minHeight: 0, paddingHorizontal: 12 },
  routeSuggestionRow: { minHeight: 70, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#ECEEEF', paddingVertical: 10, paddingHorizontal: 4, gap: 12 },
  routeSuggestionIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: '#E9F0FF', alignItems: 'center', justifyContent: 'center' },
  routeSuggestionIconText: { color: '#1769FF', fontSize: 20 },
  routeSuggestionCopy: { flex: 1 },
  routeSuggestionName: { color: '#171A21', fontSize: 14, fontWeight: '700' },
  routeSuggestionAddress: { color: '#737B87', fontSize: 12, lineHeight: 17, marginTop: 3 },
  routeSuggestionArrow: { color: '#87909A', fontSize: 24, marginLeft: 2 },
  routeSearchFooter: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 8 : 12 },
  routeSearchFooterText: { color: '#7A838D', fontSize: 11, lineHeight: 16, textAlign: 'center' },
  accountScreen: { flex: 1, backgroundColor: '#F0F2F2' },
  accountHeader: { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 22 },
  profileHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 15 },
  profilePhoto: { width: 70, height: 70, borderRadius: 35, backgroundColor: '#E4EAF2', borderWidth: 2, borderColor: '#FFFFFF' },
  profilePhotoFallback: { width: 70, height: 70, borderRadius: 35, alignItems: 'center', justifyContent: 'center', backgroundColor: '#DCE8FF', borderWidth: 2, borderColor: '#FFFFFF' },
  profilePhotoInitial: { color: '#1769FF', fontSize: 26, fontWeight: '800' },
  profileHeaderCopy: { flex: 1 },
  profilePhotoActions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 13, marginLeft: 85 },
  profilePhotoButton: { minHeight: 36, paddingHorizontal: 14, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE3EB' },
  profilePhotoButtonText: { color: '#1769FF', fontSize: 12, fontWeight: '700' },
  profilePhotoRemoveButton: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 4 },
  profilePhotoRemoveText: { color: '#697586', fontSize: 12, fontWeight: '600' },
  accountScreenTitle: { color: '#171A21', fontSize: 30, fontWeight: '800' },
  accountIdentity: { color: '#68717D', fontSize: 15, marginTop: 8 },
  accountActions: { paddingHorizontal: 18 },
  accountAction: { minHeight: 60, backgroundColor: '#FFFFFF', borderRadius: 14, marginBottom: 10, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  accountActionText: { color: '#171A21', fontSize: 16, fontWeight: '600' },
  accountActionArrow: { color: '#7B8491', fontSize: 26 },
  accountNavWrap: { marginTop: 'auto', backgroundColor: '#FFFFFF', borderTopWidth: 1, borderColor: '#E5E7EB' },
  ridesHeader: { minHeight: 86, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingVertical: 14, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E7E9E9' },
  ridesEyebrow: { color: '#737B87', fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  ridesPageTitle: { color: '#171A21', fontSize: 25, fontWeight: '800', marginTop: 3 },
  ridesRefreshButton: { minWidth: 78, height: 38, paddingHorizontal: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E9F0FF' },
  ridesRefreshText: { color: '#1769FF', fontSize: 12, fontWeight: '700' },
  ridesSectionTitle: { color: '#171A21', fontSize: 19, fontWeight: '800' },
  ridesLoadingState: { minHeight: 210, alignItems: 'center', justifyContent: 'center' },
  ridesLoadingText: { color: '#68717D', fontSize: 13, marginTop: 12 },
  emptyIconWrap: { width: 64, height: 64, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E9F0FF', marginBottom: 16 },
  rideCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 17 },
  rideStatusPill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 9, backgroundColor: '#E9F0FF' },
  rideRouteBlock: { flexDirection: 'row', alignItems: 'stretch', gap: 13 },
  rideTimeline: { width: 12, alignItems: 'center', justifyContent: 'space-between', paddingTop: 4, paddingBottom: 5 },
  ridePickupDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: '#1769FF', backgroundColor: '#FFFFFF', zIndex: 1 },
  rideTimelineLine: { position: 'absolute', top: 10, bottom: 11, width: 1, backgroundColor: '#C9D1DB' },
  rideDestinationDot: { width: 8, height: 8, borderRadius: 2, backgroundColor: '#171A21', zIndex: 1 },
  rideStops: { flex: 1, gap: 18 },
  rideStop: { flex: 1 },
  rideCardFooter: { borderTopWidth: 1, borderTopColor: '#E7E9E9', marginTop: 16, paddingTop: 12 },
  driverPanelContent: { padding: 18, paddingBottom: 28 },
  driverPanelHero: { alignItems: 'center', paddingHorizontal: 20, paddingVertical: 28, borderRadius: 22, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7E9E9' },
  driverPanelIcon: { width: 62, height: 62, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E9F0FF' },
  driverPanelIconText: { color: '#1769FF', fontSize: 34, fontWeight: '700' },
  driverPanelTitle: { color: '#171A21', fontSize: 22, fontWeight: '800', marginTop: 18 },
  driverPanelDescription: { color: '#68717D', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 8 },
  driverPanelStatus: { flexDirection: 'row', alignItems: 'flex-start', padding: 16, marginTop: 14, borderRadius: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E7E9E9' },
  driverPanelStatusDot: { width: 10, height: 10, borderRadius: 5, marginTop: 5, marginRight: 12, backgroundColor: '#F0A32F' },
  driverPanelStatusCopy: { flex: 1 },
  driverPanelStatusTitle: { color: '#171A21', fontSize: 14, fontWeight: '700' },
  driverPanelStatusText: { color: '#68717D', fontSize: 13, lineHeight: 19, marginTop: 5 },
  driverCard: { padding: 18, marginBottom: 14, borderRadius: 20, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E6EB' },
  driverCardEyebrow: { color: '#697586', fontSize: 10, fontWeight: '800', letterSpacing: 1, marginBottom: 7 },
  driverCardTitle: { color: '#171A21', fontSize: 18, fontWeight: '800', marginBottom: 7 },
  driverCardText: { color: '#596474', fontSize: 14, lineHeight: 20, marginBottom: 6 },
  driverCardMeta: { color: '#737D89', fontSize: 12, lineHeight: 18, marginTop: 5 },
  driverPrimaryButton: { minHeight: 48, paddingHorizontal: 16, marginTop: 14, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1769FF' },
  driverPrimaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  driverOfflineButton: { backgroundColor: '#E9EDF2' },
  driverOfflineButtonText: { color: '#171A21' },
  driverSecondaryButton: { minHeight: 44, paddingHorizontal: 14, marginTop: 10, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0F2F2' },
  driverSecondaryButtonText: { color: '#28313D', fontSize: 13, fontWeight: '700' },
  driverActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  driverSmallButton: { minHeight: 40, paddingHorizontal: 14, marginTop: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1769FF' },
  driverSmallButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  driverQueueSection: { padding: 2, marginTop: 8, marginBottom: 12 },
  driverQueueCard: { padding: 16, marginTop: 12, borderRadius: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E6EB' },
  driverQueueRoute: { color: '#171A21', fontSize: 15, lineHeight: 21, fontWeight: '700' },
  driverQueueDestination: { color: '#596474', fontSize: 14, lineHeight: 20, marginTop: 4 },
  driverEmptyText: { color: '#697586', fontSize: 14, marginTop: 16, padding: 16, borderRadius: 14, backgroundColor: '#FFFFFF' },
  homeMapScreen: {
    flex: 1,
    backgroundColor: '#D9E0E8',
  },
  webMapPreviewFrame: {
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
    marginVertical: 8,
    overflow: 'hidden',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#C9D2DC',
  },
  homeMapOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 2,
    pointerEvents: 'box-none',
  },
  menuButton: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', shadowColor: '#171A21', shadowOpacity: 0.16, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 6 },
  homeWordmark: { color: '#171A21', fontWeight: '900', fontSize: 17, letterSpacing: 1.6, marginLeft: 12 },
  menuIcon: { width: 20, height: 16, justifyContent: 'space-between' },
  menuIconLine: { height: 2, borderRadius: 1, width: 20, backgroundColor: '#171A21' },
  menuPopup: { position: 'absolute', top: 72, left: 16, width: 190, paddingVertical: 6, backgroundColor: '#FFFFFF', borderRadius: 14, elevation: 10, shadowColor: '#171A21', shadowOpacity: 0.16, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  menuPopupItem: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 16 },
  menuPopupText: { color: '#171A21', fontSize: 15, fontWeight: '600' },
  whereToField: { height: 58, backgroundColor: '#F0F2F2', borderRadius: 14, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  whereToPlaceholder: { flex: 1, color: '#171A21', fontSize: 18, fontWeight: '700', marginLeft: 14 },
  whereToValue: { flex: 1, color: '#171A21', fontSize: 16, fontWeight: '600', marginLeft: 14 },
  whereToArrow: { color: '#68717D', fontSize: 26, marginLeft: 8 },
  searchIconWrap: { width: 20, height: 20, position: 'relative' },
  searchIconLens: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#171A21' },
  searchIconHandle: { position: 'absolute', width: 8, height: 2, backgroundColor: '#171A21', right: 0, bottom: 1, transform: [{ rotate: '45deg' }] },
  bottomNavDivider: { height: 1, backgroundColor: '#ECEEEF', marginTop: 14 },
  bottomNavigation: { height: 66, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', backgroundColor: '#FFFFFF' },
  bottomNavigationItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 },
  bottomNavigationLabel: { color: '#7B8491', fontSize: 11, fontWeight: '500' },
  bottomNavigationLabelActive: { color: '#171A21', fontWeight: '700' },
  navHouse: { width: 23, height: 22, alignItems: 'center', justifyContent: 'flex-end' },
  navHouseRoofLeft: { position: 'absolute', top: 3, left: 2, width: 13, height: 2, transform: [{ rotate: '-40deg' }] },
  navHouseRoofRight: { position: 'absolute', top: 3, right: 2, width: 13, height: 2, transform: [{ rotate: '40deg' }] },
  navHouseBody: { width: 17, height: 13, borderWidth: 1.7, borderBottomWidth: 0, alignItems: 'center', justifyContent: 'flex-end' },
  navHouseDoor: { width: 5, height: 8, borderWidth: 1.4, borderBottomWidth: 0 },
  navCalendar: { width: 20, height: 19, borderWidth: 1.6, borderRadius: 4, overflow: 'hidden', alignItems: 'center' },
  navCalendarTop: { width: '100%', height: 3, marginTop: 4 },
  navCalendarRingLeft: { position: 'absolute', width: 2, height: 5, top: -1, left: 4 },
  navCalendarRingRight: { position: 'absolute', width: 2, height: 5, top: -1, right: 4 },
  navCalendarClock: { position: 'absolute', right: -4, bottom: -4, width: 12, height: 12, borderWidth: 1.4, borderRadius: 6, backgroundColor: '#FFFFFF' },
  navCalendarClockHand: { position: 'absolute', top: 2, left: 5, width: 1, height: 4 },
  navProfile: { width: 22, height: 22, alignItems: 'center', justifyContent: 'flex-end' },
  navProfileHead: { position: 'absolute', top: 0, width: 9, height: 9, borderRadius: 5 },
  navProfileShoulders: { width: 20, height: 11, borderWidth: 1.6, borderBottomWidth: 0, borderTopLeftRadius: 10, borderTopRightRadius: 10 },
  sheetKeyboardOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'flex-end',
  },
  mapUnavailable: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    backgroundColor: '#D9E0E8',
  },
  mapUnavailableText: {
    color: '#334155',
    textAlign: 'center',
    fontSize: 15,
  },
  homeMapHeader: {
    marginHorizontal: 16,
    marginTop: Platform.OS === 'android' ? 12 : 8,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  homeHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 0,
  },
  homeIconButton: {
    width: 40,
    height: 40,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0F2F2',
  },
  homeIconText: {
    color: '#171A21',
    fontSize: 22,
    fontWeight: '800',
  },
  homeTripsButton: {
    minWidth: 52,
    height: 36,
    paddingHorizontal: 8,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DFE5EC',
  },
  homeTripsButtonText: {
    color: '#33445A',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
  },
  homeAccountButton: {
    paddingHorizontal: 10,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    backgroundColor: '#F0F2F2',
  },
  homeAccountButtonText: {
    color: '#26374D',
    fontSize: 11,
    fontWeight: '800',
  },
  mapControls: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 96 : 102,
    left: 17,
    right: 17,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  homeLocationButton: {
    marginLeft: 'auto',
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 0,
    shadowColor: '#171A21',
    shadowOpacity: 0.16,
    shadowRadius: 8,
    elevation: 4,
  },
  locationTargetOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#1769FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationTargetInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#1769FF',
  },
  homeBookingPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 3,
    marginHorizontal: 0,
    marginBottom: 0,
    paddingTop: 10,
    paddingHorizontal: 18,
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    backgroundColor: '#FFFFFF',
    shadowColor: '#171A21',
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 14,
  },
  homeBookingPanelExpanded: {
    maxHeight: '90%',
  },
  homeBookingPanelContent: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
  },
  panelGrabber: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#A9B2BE',
    marginBottom: 12,
  },
  bookingHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  homePanelTitle: {
    color: '#171A21',
    fontSize: 20,
    fontWeight: '900',
  },
  homePanelSubtitle: {
    color: '#5C6879',
    fontSize: 12,
    marginTop: 3,
  },
  homeRouteIntro: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: 15,
  },
  homeRouteTitleBlock: {
    gap: 5,
  },
  routeEyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  routeEyebrowMark: {
    width: 15,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#1769FF',
  },
  routeEyebrow: {
    color: '#58677B',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.3,
  },
  routeEditor: {
    padding: 9,
    borderRadius: 18,
    backgroundColor: '#E7E9E9',
  },
  routePickupRow: {
    minHeight: 55,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: '#F0F2F2',
  },
  routePickupSelect: {
    flex: 1,
    minHeight: 55,
    flexDirection: 'row',
    alignItems: 'center',
  },
  routePickupIcon: {
    width: 26,
    alignItems: 'center',
    marginRight: 7,
  },
  routeStopCopy: {
    flex: 1,
    justifyContent: 'center',
  },
  routeStopLabel: {
    color: '#718096',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
    marginBottom: 3,
  },
  routeLocateButton: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E1E8F2',
  },
  routeLocateIcon: {
    color: '#1769FF',
    fontSize: 21,
    fontWeight: '700',
  },
  routeLinkRow: {
    height: 23,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 20,
  },
  routeLinkLine: {
    height: 16,
    width: 1,
    backgroundColor: '#8290A2',
  },
  routeLinkLabel: {
    marginLeft: 10,
    color: '#718096',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
  },
  cashPill: {
    backgroundColor: '#D6DDE5',
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  cashPillText: {
    color: '#34445A',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  homeTargetTabs: {
    flexDirection: 'row',
    backgroundColor: '#D8DEE5',
    padding: 3,
    borderRadius: 13,
    marginBottom: 10,
  },
  homeTargetTab: {
    flex: 1,
    minHeight: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeTargetTabActive: {
    backgroundColor: '#F4F5F7',
  },
  homeTargetText: {
    color: '#697688',
    fontSize: 12,
    fontWeight: '700',
  },
  homeTargetTextActive: {
    color: '#171A21',
  },
  homePickupField: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    marginBottom: 8,
    borderRadius: 13,
    backgroundColor: '#F2F3F5',
  },
  pickupPinIcon: {
    width: 21,
    height: 24,
    alignItems: 'center',
    justifyContent: 'flex-start',
    marginRight: 10,
  },
  pickupPinTail: {
    position: 'absolute',
    bottom: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#1769FF',
  },
  pickupPinHead: {
    width: 17,
    height: 17,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1769FF',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    zIndex: 1,
  },
  pickupPinCore: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  mapPickupMarker: {
    width: 38,
    height: 48,
    alignItems: 'center',
  },
  mapPickupMarkerHead: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#1769FF',
    borderWidth: 3,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  mapPickupMarkerCore: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#FFFFFF',
  },
  mapPickupMarkerTail: {
    marginTop: -2,
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderTopWidth: 13,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#1769FF',
  },
  homeFieldValue: {
    flex: 1,
    color: '#171A21',
    fontSize: 12,
  },
  homeFieldPlaceholder: {
    flex: 1,
    color: '#737F90',
    fontSize: 12,
  },
  homeFieldAction: {
    marginLeft: 8,
    color: '#1769FF',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  homeDestinationField: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 13,
    paddingRight: 5,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#CBD3DD',
    backgroundColor: '#F0F2F2',
  },
  homeDestinationFieldActive: {
    borderColor: '#1769FF',
    backgroundColor: '#FFFFFF',
  },
  destinationMarkerSquare: {
    width: 9,
    height: 9,
    backgroundColor: '#171A21',
    marginRight: 11,
  },
  homeDestinationInput: {
    flex: 1,
    minHeight: 50,
    color: '#171A21',
    fontSize: 16,
    fontWeight: '700',
  },
  homeFindButton: {
    minWidth: 56,
    height: 42,
    borderRadius: 11,
    backgroundColor: '#1769FF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 11,
  },
  homeFindButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  homeSignupLink: {
    alignItems: 'center',
    paddingTop: 10,
  },
  homeSignupText: {
    color: '#4E5D71',
    fontSize: 11,
    fontWeight: '700',
  },
  homeFareEstimate: {
    minHeight: 64,
    marginTop: 12,
    paddingLeft: 0,
    paddingRight: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 15,
    overflow: 'hidden',
    backgroundColor: '#F0F2F2',
  },
  fareAccent: {
    width: 4,
    alignSelf: 'stretch',
    backgroundColor: '#1769FF',
    marginRight: 11,
  },
  homeFareLabel: {
    color: '#4C5B70',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.9,
  },
  homeFareNote: {
    color: '#667387',
    fontSize: 10,
    marginTop: 3,
  },
  homeFareAmount: {
    color: '#1769FF',
    fontSize: 20,
    fontWeight: '900',
  },
  packageSectionLabel: {
    color: '#596579',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginTop: 5,
    marginBottom: 8,
  },
  rideOptionRow: {
    flexDirection: 'row',
    gap: 7,
  },
  rideOptionCard: {
    flex: 1,
    minHeight: 108,
    paddingHorizontal: 9,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D2D9E2',
    backgroundColor: '#F0F2F2',
  },
  rideOptionCardSelected: {
    borderColor: '#1769FF',
    backgroundColor: '#E9F0FF',
  },
  rideOptionTopline: {
    height: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  rideOptionIndex: {
    color: '#8490A0',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  rideOptionIndexSelected: {
    color: '#1769FF',
  },
  rideOptionSelectedMark: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#1769FF',
  },
  rideOptionTitle: {
    minHeight: 28,
    color: '#34445A',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
  },
  rideOptionTitleSelected: {
    color: '#1D4ED8',
  },
  rideOptionDetail: {
    color: '#718096',
    fontSize: 9,
  },
  rideOptionFare: {
    color: '#171A21',
    fontSize: 17,
    fontWeight: '900',
    marginTop: 8,
  },
  rideOptionCapacity: {
    color: '#718096',
    fontSize: 9,
    marginTop: 1,
  },
  passengerSelector: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    marginBottom: 4,
  },
  passengerLabel: {
    color: '#171A21',
    fontSize: 12,
    fontWeight: '800',
  },
  passengerHint: {
    color: '#718096',
    fontSize: 10,
    marginTop: 3,
  },
  passengerStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
  },
  stepperButton: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#D8DFE7',
  },
  stepperButtonDisabled: {
    opacity: 0.4,
  },
  stepperButtonText: {
    color: '#171A21',
    fontSize: 20,
    lineHeight: 23,
    fontWeight: '700',
  },
  passengerCount: {
    minWidth: 15,
    color: '#171A21',
    fontSize: 15,
    fontWeight: '900',
    textAlign: 'center',
  },
  fareEstimateCard: {
    padding: 12,
    marginBottom: 5,
    borderRadius: 14,
    backgroundColor: '#E7E9E9',
  },
  fareEstimateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fareEstimateTitle: {
    color: '#171A21',
    fontSize: 13,
    fontWeight: '900',
  },
  fareEstimateDistance: {
    color: '#667387',
    fontSize: 10,
    marginTop: 3,
  },
  fareEstimateAmount: {
    color: '#171A21',
    fontSize: 20,
    fontWeight: '900',
  },
  fareEstimateNote: {
    color: '#596579',
    fontSize: 9,
    lineHeight: 13,
    marginTop: 7,
  },
  safeArea: {
    flex: 1,
    backgroundColor: '#F0F2F2',
  },
  fullMapScreen: {
    flex: 1,
    backgroundColor: '#F0F2F2',
  },
  mapOverlay: {
    flex: 1,
  },
  mapHeader: {
    marginTop: Platform.OS === 'android' ? 12 : 4,
    marginHorizontal: 16,
    minHeight: 62,
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#171A21',
    shadowOpacity: 0.10,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontSize: 32,
    color: '#171A21',
    marginTop: -4,
  },
  mapHeaderText: {
    flex: 1,
    paddingLeft: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rideStepMark: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E9F0FF',
  },
  rideStepMarkText: {
    color: '#1769FF',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  mapHeaderKicker: {
    color: '#788598',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1,
  },
  brandMarkSmall: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1769FF',
  },
  brandMarkSmallText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
  },
  mapHeaderSubtitle: {
    fontSize: 13,
    color: '#171A21',
    fontWeight: '800',
    marginTop: 2,
  },
  myLocationButton: {
    width: 44,
    height: 44,
    borderRadius: 15,
    backgroundColor: '#E9F0FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationIcon: {
    color: '#1769FF',
    fontSize: 28,
  },
  bookingPanel: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderWidth: 1,
    borderColor: '#E7E9E9',
    marginHorizontal: 0,
    marginBottom: 0,
    maxHeight: '72%',
    flexGrow: 0,
    shadowColor: '#171A21',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -5 },
    elevation: 15,
  },
  bookingPanelExpanded: {
    maxHeight: '90%',
  },
  bookingPanelContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
  },
  panelTitle: {
    color: '#171A21',
    fontSize: 23,
    fontWeight: '900',
  },
  bookingEyebrow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 7,
  },
  bookingEyebrowMark: {
    width: 18,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#1769FF',
  },
  bookingEyebrowText: {
    color: '#667387',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.1,
  },
  panelSubtitle: {
    color: '#64748B',
    fontSize: 12,
    marginTop: 5,
    marginBottom: 15,
  },
  targetRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  targetButton: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E7E9E9',
    paddingVertical: 12,
    alignItems: 'center',
  },
  targetSelected: {
    borderColor: '#1769FF',
    backgroundColor: '#E9F0FF',
  },
  targetText: {
    color: '#596579',
    fontSize: 12,
    fontWeight: '700',
  },
  targetTextSelected: {
    color: '#1769FF',
  },
  locationInput: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E7E9E9',
    borderRadius: 14,
    paddingHorizontal: 12,
    marginBottom: 9,
  },
  locationValue: {
    color: '#171A21',
    fontSize: 12,
    flex: 1,
  },
  locationPlaceholder: {
    color: '#64748B',
    fontSize: 12,
    flex: 1,
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  destinationInput: {
    flex: 1,
    minHeight: 46,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingHorizontal: 12,
    color: '#171A21',
    fontSize: 12,
    backgroundColor: '#F0F2F2',
  },
  locationSuggestions: {
    marginTop: 7,
    marginBottom: 11,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#D2D9E2',
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
  },
  locationSuggestionRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    borderBottomWidth: 1,
    borderBottomColor: '#DDE2E8',
  },
  suggestionPin: {
    width: 31,
    height: 31,
    borderRadius: 10,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E0E6ED',
  },
  suggestionPinText: {
    color: '#1769FF',
    fontSize: 18,
    fontWeight: '800',
  },
  locationSuggestionText: {
    flex: 1,
    color: '#171A21',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
  },
  suggestionArrow: {
    color: '#778397',
    fontSize: 22,
    marginLeft: 8,
  },
  suggestionsLoadingRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 9,
  },
  suggestionsMessage: {
    color: '#667387',
    fontSize: 11,
    paddingHorizontal: 13,
    paddingVertical: 12,
  },
  searchButton: {
    minWidth: 62,
    borderRadius: 12,
    backgroundColor: '#1769FF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  searchButtonText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 12,
  },
  cashLabel: {
    color: '#596579',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 8,
  },
  cashBox: {
    minHeight: 56,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DCE5F0',
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    marginBottom: 13,
  },
  cashIcon: {
    color: '#1769FF',
    fontSize: 18,
    fontWeight: '900',
    marginRight: 12,
  },
  cashTitle: {
    color: '#171A21',
    fontSize: 13,
    fontWeight: '800',
  },
  cashSubtitle: {
    color: '#596579',
    fontSize: 11,
    marginTop: 3,
  },
  cashCheck: {
    color: '#1769FF',
    fontSize: 18,
    fontWeight: '900',
  },
  primaryButton: {
    minHeight: 52,
    alignSelf: 'stretch',
    borderRadius: 15,
    backgroundColor: '#1769FF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    marginTop: 8,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900',
  },
  disabledButton: {
    opacity: 0.65,
  },
  secondaryButton: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DCE5F0',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    marginTop: 12,
  },
  secondaryButtonText: {
    color: '#171A21',
    fontWeight: '800',
    fontSize: 13,
  },
  smallNote: {
    textAlign: 'center',
    color: '#94A3B8',
    fontSize: 9,
    lineHeight: 14,
    marginTop: 8,
  },
  homeContainer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 30,
  },
  homeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  homeBrandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  smallLogo: {
    width: 38,
    height: 38,
    flexShrink: 0,
    backgroundColor: '#1769FF',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallLogoText: {
    color: '#FFFFFF',
    fontSize: 23,
    fontWeight: '900',
  },
  brandTagline: {
    color: '#64748B',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginTop: 1,
    flexShrink: 1,
  },
  signInButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#E9F0FF',
  },
  signInText: {
    color: '#1769FF',
    fontWeight: '800',
    fontSize: 12,
  },
  signOutButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  signOutText: {
    color: '#64748B',
    fontWeight: '700',
    fontSize: 12,
  },
  heroCard: {
    backgroundColor: '#171A21',
    borderRadius: 26,
    padding: 22,
    overflow: 'hidden',
    marginBottom: 28,
  },
  heroBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#253754',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  heroBadgeText: {
    color: '#93C5FD',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 42,
    fontWeight: '900',
    lineHeight: 46,
    marginTop: 20,
  },
  heroDescription: {
    color: '#CBD5E1',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 12,
    maxWidth: 260,
  },
  heroIllustration: {
    height: 110,
    marginTop: 5,
    marginBottom: 8,
    position: 'relative',
  },
  roadLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 65,
    height: 3,
    backgroundColor: '#334155',
    borderRadius: 2,
  },
  pinCircle: {
    position: 'absolute',
    left: '17%',
    top: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1769FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '900',
  },
  carBody: {
    position: 'absolute',
    right: '12%',
    top: 43,
    width: 75,
    height: 31,
    borderRadius: 10,
    backgroundColor: '#171A21',
  },
  carWindow: {
    position: 'absolute',
    top: 5,
    left: 17,
    width: 39,
    height: 11,
    borderRadius: 4,
    backgroundColor: '#93C5FD',
  },
  carWheelLeft: {
    position: 'absolute',
    left: 10,
    bottom: -5,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: '#64748B',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  carWheelRight: {
    position: 'absolute',
    right: 10,
    bottom: -5,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: '#64748B',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  sectionHeading: {
    color: '#171A21',
    fontSize: 20,
    fontWeight: '900',
    marginBottom: 6,
  },
  featureCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#171A21',
    borderWidth: 1,
    borderColor: '#F0F2F2',
    borderRadius: 18,
    padding: 14,
    marginTop: 12,
  },
  featureIconBlue: {
    width: 45,
    height: 45,
    borderRadius: 14,
    backgroundColor: '#E9F0FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureIconDark: {
    width: 45,
    height: 45,
    borderRadius: 14,
    backgroundColor: '#171A21',
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureIconText: {
    color: '#1769FF',
    fontSize: 21,
    fontWeight: '900',
  },
  featureTextContainer: {
    flex: 1,
    paddingHorizontal: 12,
  },
  featureTitle: {
    color: '#F9FAFB',
    fontSize: 13,
    fontWeight: '800',
  },
  featureDescription: {
    color: '#64748B',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
  },
  featureArrow: {
    color: '#1769FF',
    fontSize: 26,
    paddingHorizontal: 4,
  },
  accountCard: {
    marginTop: 22,
    padding: 18,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  accountTitle: {
    color: '#F9FAFB',
    fontSize: 18,
    fontWeight: '900',
  },
  accountDescription: {
    color: '#64748B',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
    marginBottom: 8,
  },
  footerText: {
    textAlign: 'center',
    color: '#94A3B8',
    fontSize: 10,
    marginTop: 28,
  },
  authContainer: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 40,
    justifyContent: 'center',
  },
  authBack: {
    alignSelf: 'flex-start',
    paddingVertical: 10,
    marginBottom: 20,
  },
  authBackText: {
    color: '#1769FF',
    fontSize: 14,
    fontWeight: '800',
  },
  logoMark: {
    width: 58,
    height: 58,
    borderRadius: 19,
    backgroundColor: '#1769FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  logoMarkText: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '900',
  },
  authTitle: {
    color: '#171A21',
    fontSize: 28,
    fontWeight: '900',
    marginTop: 4,
  },
  authSubtitle: {
    color: '#64748B',
    fontSize: 13,
    marginTop: 8,
    marginBottom: 28,
  },
  fieldLabel: {
    color: '#334155',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 8,
    marginTop: 12,
  },
  textInput: {
    height: 52,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#E2E5E7',
    paddingHorizontal: 14,
    color: '#171A21',
    fontSize: 14,
    backgroundColor: '#FFFFFF',
  },
  authSwitch: {
    alignItems: 'center',
    paddingVertical: 22,
  },
  authSwitchText: {
    color: '#1769FF',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E7E9E9',
    backgroundColor: '#FFFFFF',
  },
  pageTitle: {
    color: '#171A21',
    fontSize: 18,
    fontWeight: '900',
  },
  ridesContainer: {
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 30,
  },
  sectionDescription: {
    color: '#68717D',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
    marginBottom: 14,
  },
  emptyState: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E7E9E9',
    alignItems: 'center',
    padding: 22,
    marginTop: 8,
  },
  emptyIcon: {
    fontSize: 31,
    color: '#1769FF',
  },
  emptyTitle: {
    color: '#171A21',
    fontSize: 19,
    fontWeight: '900',
  },
  emptyText: {
    color: '#68717D',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 7,
    marginBottom: 10,
  },
  rideCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E7E9E9',
    borderRadius: 20,
    padding: 17,
    marginTop: 12,
  },
  rideStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
  },
  rideStatus: {
    color: '#1769FF',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  rideDate: {
    color: '#737B87',
    fontSize: 11,
  },
  rideLabel: {
    color: '#7A838D',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  rideAddress: {
    color: '#171A21',
    fontSize: 13,
    lineHeight: 18,
  },
  rideDivider: {
    height: 1,
    backgroundColor: '#E7E9E9',
    marginVertical: 13,
  },
  ridePayment: {
    color: '#68717D',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
});
